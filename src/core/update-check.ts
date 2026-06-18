// Passive update notifier — the update-notifier UX without the dependency.
//
// Design: NEVER block, NEVER throw, NEVER nag a script. We hit npm's registry at
// most once per day (cached in the data dir), and only print to STDERR when a
// human is at the keyboard (TTY) and hasn't opted out. A slow or failed check is
// indistinguishable from "you're up to date" — it just shows nothing.
//
// Two things can refresh the cache: the daily registry poll here, and the cloud
// sync response (the backend advertises the latest version on every /v1/sync —
// see version-gate.ts + sync-client.ts), so even a user who never runs an
// interactive command still learns about a release via their auto-sync job's
// next interactive session. recordLatest() is the entry point for that path.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { cliVersion, isNewer } from './version.js';

const REGISTRY_URL = 'https://registry.npmjs.org/codenomics/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // poll the registry at most daily
const FETCH_TIMEOUT_MS = 1500;                 // a check never costs the user more than this

interface UpdateCache {
  /** epoch ms of the last registry poll (or server-advertised refresh). */
  checkedAt: number;
  /** latest version string we last learned about. */
  latest: string;
}

function cachePath(): string {
  return path.join(dataDir(), '.update-check.json');
}

function readCache(): UpdateCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<UpdateCache>;
    if (typeof raw.checkedAt === 'number' && typeof raw.latest === 'string') {
      return { checkedAt: raw.checkedAt, latest: raw.latest };
    }
  } catch {
    /* missing/corrupt cache == never checked */
  }
  return null;
}

function writeCache(c: UpdateCache): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(c) + '\n');
  } catch {
    /* best-effort: a failed cache write just means we re-poll next time */
  }
}

/** Record a latest-version hint learned out-of-band (e.g. from a sync response).
 *  Stamps the cache as freshly checked so it both suppresses a redundant poll and
 *  surfaces on the next interactive command. */
export function recordLatest(latest: string, now = Date.now()): void {
  if (parseable(latest)) writeCache({ checkedAt: now, latest });
}

function parseable(v: string): boolean {
  return /^\d+\.\d+\.\d+/.test(String(v).trim().replace(/^v/, ''));
}

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(REGISTRY_URL, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null; // offline, timeout, DNS, parse — all "unknown", never an error
  } finally {
    clearTimeout(timer);
  }
}

export interface CheckOptions {
  current?: string;
  now?: number;
  fetchImpl?: typeof fetch;
}

export interface CheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/** Resolve the latest version, polling the registry at most once per CHECK_INTERVAL_MS
 *  and caching the answer. Pure-ish: all I/O is the cache file + the injectable fetch.
 *  Never throws. */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<CheckResult> {
  const current = opts.current ?? cliVersion();
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;

  let latest: string | null = null;
  const cache = readCache();
  if (cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
    latest = cache.latest; // fresh enough — no network
  } else {
    latest = await fetchLatest(fetchImpl);
    if (latest) writeCache({ checkedAt: now, latest });
    else if (cache) latest = cache.latest; // poll failed: fall back to last known
  }

  return { current, latest, updateAvailable: latest != null && isNewer(latest, current) };
}

/** The boxed footer shown when an update is available. */
export function updateNotice(current: string, latest: string): string {
  const line = `  Update available: ${current} → ${latest}`;
  const cmd = '  Run: npm i -g codenomics@latest';
  const width = Math.max(line.length, cmd.length) + 2;
  const bar = '─'.repeat(width);
  return ['', `┌${bar}┐`, `│${pad(line, width)}│`, `│${pad(cmd, width)}│`, `└${bar}┘`, ''].join('\n');
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

/** True when we should even attempt a check: a human at a TTY who hasn't opted out
 *  and isn't running the machine sync path. Honors the de-facto NO_UPDATE_NOTIFIER
 *  and CI conventions plus a codenomics-specific override. */
export function shouldNotify(cmd: string, argv: string[]): boolean {
  if (process.env.CODENOMICS_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) return false;
  if (process.env.CI) return false;
  if (!process.stderr.isTTY) return false;       // piped/redirected/scheduled — stay silent
  if (cmd === 'sync') return false;              // the auto-sync path is non-interactive
  if (cmd === 'doctor') return false;            // doctor prints its own '# version' section
  if (argv.includes('--json')) return false;     // machine-readable output must stay clean
  return true;
}

/** Fire-and-(almost)-forget: gate, check, and print the notice to stderr. Bounded
 *  by FETCH_TIMEOUT_MS and never throws, so it's safe to await at the end of a run. */
export async function maybeNotifyUpdate(cmd: string, argv: string[]): Promise<void> {
  try {
    if (!shouldNotify(cmd, argv)) return;
    const { current, latest, updateAvailable } = await checkForUpdate();
    if (updateAvailable && latest) process.stderr.write(updateNotice(current, latest) + '\n');
  } catch {
    /* a notifier must never break the command it follows */
  }
}
