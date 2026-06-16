// Local dashboard server. Localhost-only by default. All money math happens
// here (core/metrics) so the dashboard and reports can never disagree.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, saveUserConfig, mergeConfig, validateConfig, type CodenomicsConfig } from '../core/config.js';
import { readIndex, readSummaries, reportsDir } from '../core/store.js';
import { runIndex } from '../core/engine.js';
import { annotateSession } from '../core/metrics.js';
import { usageCostUsd } from '../core/pricing.js';
import { evaluateBudgets } from '../core/budgets.js';
import { sessionKey } from '../core/schema.js';
import { allCollectors } from '../collectors/registry.js';
import { summarizeSessions } from '../summarize.js';
import { benchmarkPanel } from './benchmark.js';

const REINDEX_STALE_MS = 5 * 60 * 1000;
const PUBLIC_DIR = new URL('../../public/', import.meta.url).pathname;

let reindexing: Promise<void> | null = null;
let summarizing = false;

function reindex(cfg: CodenomicsConfig): Promise<void> {
  if (reindexing) return reindexing;
  reindexing = runIndex(cfg, allCollectors())
    .then(() => {
      startSummarize(15); // no-ops fast when nothing is missing
    })
    .catch((err) => console.error('reindex failed:', err))
    .finally(() => {
      reindexing = null;
    });
  return reindexing;
}

function startSummarize(limit: number): boolean {
  if (summarizing) return false;
  summarizing = true;
  summarizeSessions(limit)
    .catch(() => {})
    .finally(() => {
      summarizing = false;
    });
  return true;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStatic(res: http.ServerResponse, file: string, type: string): void {
  try {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Hostname (no port) from a Host or Origin header value. */
function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * CSRF guard for state-changing requests. A browser always sends Origin on
 * cross-site POST/PUT; we require it to be loopback. Same-origin tools (curl,
 * the dashboard itself) either send a loopback Origin or none, and we fall back
 * to the Host header. Blocks drive-by POSTs from arbitrary web pages.
 */
function sameOriginOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    const h = hostnameOf(origin);
    return h !== null && isLoopbackHost(h);
  }
  // no Origin (non-browser client): require a loopback Host header
  const h = hostnameOf(req.headers.host);
  return h !== null && isLoopbackHost(h);
}

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): http.Server {
  const { config: bootCfg } = loadConfig();
  const host = opts.host ?? bootCfg.server.host;
  const port = opts.port ?? bootCfg.server.port;
  const remote = !isLoopbackHost(host);
  // Non-loopback binds expose usage data to the network; gate /api/* behind a
  // token printed once at startup. Loopback binds rely on the CSRF check only.
  const token = remote ? crypto.randomBytes(16).toString('hex') : null;

  const tokenOk = (req: http.IncomingMessage, url: URL): boolean => {
    if (!token) return true;
    const supplied = req.headers['x-codenomics-token'] ?? url.searchParams.get('token');
    return typeof supplied === 'string' && supplied.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { config } = loadConfig(); // fresh each request: config edits apply instantly

    try {
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/reports/');
      if (isApi && !tokenOk(req, url)) {
        json(res, 401, { error: 'missing or invalid token' });
        return;
      }
      const mutating = req.method === 'PUT' || req.method === 'POST';
      if (mutating && !sameOriginOk(req)) {
        json(res, 403, { error: 'cross-origin request refused' });
        return;
      }
      if (url.pathname === '/api/data') {
        const stale = Date.now() - readIndex().generatedAt > REINDEX_STALE_MS;
        if (stale) await reindex(config);
        const index = readIndex();
        const sums = readSummaries();
        const sessions = index.sessions.map((s) => {
          const annotated = annotateSession(s, config) as ReturnType<typeof annotateSession> & {
            summary?: string;
            modelCosts?: Record<string, number | null>;
          };
          const sum = sums[sessionKey(s)];
          if (sum) annotated.summary = sum.text;
          annotated.modelCosts = Object.fromEntries(
            Object.entries(s.models).map(([m, u]) => [m, usageCostUsd(m, u, config)]),
          );
          return annotated;
        });
        json(res, 200, {
          generatedAt: index.generatedAt,
          sessions,
          summarizing,
          budgets: evaluateBudgets(index.sessions, config),
          config: { drivers: config.drivers, limits: config.limits },
          capabilities: Object.fromEntries(allCollectors().map((c) => [c.vendor, c.capabilities])),
        });
        return;
      }

      if (url.pathname === '/api/benchmark') {
        // self-locate the user's cohort ratios against the cloud distribution;
        // the sync token stays server-side (never sent to the browser)
        const panel = await benchmarkPanel(readIndex().sessions, config);
        json(res, 200, panel);
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'PUT') {
        const patch = JSON.parse(await readBody(req)) as Partial<CodenomicsConfig>;
        // only drivers/limits/pricing are editable from the UI
        const allowed: Record<string, unknown> = {};
        if (patch.drivers) allowed.drivers = patch.drivers;
        if (patch.limits) allowed.limits = patch.limits;
        if (patch.pricing) allowed.pricing = patch.pricing;
        const { config: current } = loadConfig();
        const next = mergeConfig(current, allowed);
        const problems = validateConfig(next);
        if (problems.length) {
          json(res, 400, { ok: false, problems });
          return;
        }
        saveUserConfig(next);
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/api/summarize' && req.method === 'POST') {
        const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25));
        const started = startSummarize(limit);
        json(res, 200, { started, alreadyRunning: !started });
        return;
      }

      if (url.pathname === '/api/reports') {
        let files: string[] = [];
        try {
          files = fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.html') || f.endsWith('.md'));
        } catch {
          // no reports yet
        }
        json(res, 200, { reports: files.sort().reverse() });
        return;
      }

      if (url.pathname.startsWith('/reports/')) {
        const name = path.basename(url.pathname); // no traversal
        const file = path.join(reportsDir(), name);
        try {
          const body = fs.readFileSync(file);
          res.writeHead(200, {
            'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          });
          res.end(body);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        }
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        serveStatic(res, 'index.html', 'text/html; charset=utf-8');
        return;
      }
      if (url.pathname === '/app.js') {
        serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
        return;
      }
      if (url.pathname === '/style.css') {
        serveStatic(res, 'style.css', 'text/css; charset=utf-8');
        return;
      }
      if (url.pathname === '/favicon.ico') {
        serveStatic(res, 'assets/brand/favicon.ico', 'image/x-icon');
        return;
      }
      if (url.pathname.startsWith('/assets/brand/')) {
        const name = path.basename(url.pathname); // no traversal
        const ASSET_TYPES: Record<string, string> = {
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
        };
        const type = ASSET_TYPES[path.extname(name).toLowerCase()];
        if (type) {
          serveStatic(res, path.join('assets/brand', name), type);
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      console.error(err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, host, () => {
    const base = `http://${host}:${port}`;
    if (remote) {
      console.warn('warning: binding beyond localhost exposes your usage data to the network');
      console.log(`codenomics dashboard: ${base}/?token=${token}`);
      console.log('  access token required on /api requests — open the URL above.');
    } else {
      console.log(`codenomics dashboard: ${base}`);
    }
  });
  return server;
}
