// Local dashboard server. Localhost-only by default. All money math happens
// here (core/metrics) so the dashboard and reports can never disagree.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveUserConfig, mergeConfig, validateConfig, type CodenomicsConfig } from '../core/config.js';
import { readIndex, readSummaries, reportsDir } from '../core/store.js';
import { runIndex } from '../core/engine.js';
import { annotateSession } from '../core/metrics.js';
import { usageCostUsd } from '../core/pricing.js';
import { evaluateBudgets } from '../core/budgets.js';
import { sessionKey } from '../core/schema.js';
import { allCollectors } from '../collectors/registry.js';
import { summarizeSessions } from '../summarize.js';

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

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(opts: ServerOptions = {}): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { config } = loadConfig(); // fresh each request: config edits apply instantly

    try {
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

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      console.error(err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const { config } = loadConfig();
  const port = opts.port ?? config.server.port;
  const host = opts.host ?? config.server.host;
  server.listen(port, host, () => {
    console.log(`codenomics dashboard: http://${host}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn('warning: binding beyond localhost exposes your usage data to the network');
    }
  });
  return server;
}
