// Shared cloud-sync client — the single place that builds the aggregates payload
// and POSTs it to /v1/sync. Used by the `sync` CLI command, the auto-sync
// scheduled job, and the dashboard's sync-on-serve. Aggregates only; the project
// key is hashed before anything leaves the machine. See PRIVACY.md.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { buildRollups } from './rollup.js';
import { SCHEMA_VERSION, type ProjectHash, type RollupV1Wire, type SessionV1 } from './schema.js';
import { clientHeaders } from './version.js';
import { recordLatest } from './update-check.js';

// Rows per request. The backend caps a single body well above this; chunking
// keeps payloads small and lets a partial failure retry cheaply.
const CHUNK = 5000;

export interface SyncState {
  /** ISO timestamp of the last SUCCESSFUL sync, or null if never. */
  lastSyncedAt: string | null;
  /** accepted-row count from the last successful sync. */
  acceptedRows: number;
  /** error string from the last attempt (null after a success). */
  lastError: string | null;
  /** ISO timestamp of the last attempt, success or failure. */
  lastAttemptAt: string | null;
}

const EMPTY_STATE: SyncState = { lastSyncedAt: null, acceptedRows: 0, lastError: null, lastAttemptAt: null };

function syncStatePath(): string {
  return path.join(dataDir(), '.sync-state.json');
}

export function readSyncState(): SyncState {
  try {
    const raw = JSON.parse(fs.readFileSync(syncStatePath(), 'utf8')) as Partial<SyncState>;
    return {
      lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
      acceptedRows: typeof raw.acceptedRows === 'number' ? raw.acceptedRows : 0,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : null,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeSyncState(s: SyncState): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(syncStatePath(), JSON.stringify(s, null, 2) + '\n');
  } catch {
    // best-effort: a missing sync-state file just means "unknown last sync".
  }
}

/** Hash a project key so the one potentially identifying string never leaves the
 *  machine in the clear (privacy commitment). The backend also requires project
 *  to be a hex hash, which this satisfies. */
export function hashProject(project: string, salt: string): ProjectHash {
  return createHash('sha256').update(salt).update('\0').update(project).digest('hex') as ProjectHash;
}

/** The exact rows that get uploaded (project hashed). Pure — no I/O. The branded
 *  ProjectHash return type makes this the only place a raw project becomes wire-safe. */
export function buildPayload(sessions: SessionV1[], salt: string): RollupV1Wire[] {
  return buildRollups(sessions).map((r) => ({ ...r, project: hashProject(r.project, salt) }));
}

export interface PushResult {
  ok: boolean;
  accepted: number;
  error?: string;
}

/** Build + push the aggregates payload. Records sync state. Never throws —
 *  returns {ok:false,error} so callers (CLI, scheduler, server) handle it. */
export async function pushRollups(opts: {
  endpoint: string;
  token: string;
  salt?: string;
  sessions: SessionV1[];
  now?: () => Date;
}): Promise<PushResult> {
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const rows = buildPayload(opts.sessions, opts.salt ?? '');
  const url = `${endpoint}/v1/sync`;

  let accepted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}`, ...clientHeaders() },
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, rollups: chunk }),
      });
    } catch (e) {
      const error = `sync failed: ${(e as Error).message}`;
      writeSyncState({ ...readSyncState(), lastError: error, lastAttemptAt: nowIso });
      return { ok: false, accepted, error };
    }
    if (!res.ok) {
      // 426 Upgrade Required == the backend refused this CLI as too old. Surface
      // an actionable message instead of a raw HTTP code, and prime the update
      // notifier so the next interactive command repeats the nudge.
      if (res.status === 426) {
        const latest = res.headers.get('x-codenomics-latest');
        if (latest) recordLatest(latest);
        const error = `sync rejected: this codenomics CLI is too old for the benchmark server${latest ? ` (latest ${latest})` : ''}. Upgrade: npm i -g codenomics@latest`;
        writeSyncState({ ...readSyncState(), lastError: error, lastAttemptAt: nowIso });
        return { ok: false, accepted, error };
      }
      const detail = await res.text().catch(() => '');
      const error = `sync rejected (HTTP ${res.status}): ${detail.slice(0, 300)}`;
      writeSyncState({ ...readSyncState(), lastError: error, lastAttemptAt: nowIso });
      return { ok: false, accepted, error };
    }
    // The server advertises the latest published version on every success; record
    // it so an out-of-date CLI gets nudged even when npm's registry is unreachable.
    const advertised = res.headers.get('x-codenomics-latest');
    if (advertised) recordLatest(advertised);
    const body = (await res.json().catch(() => ({}))) as { accepted?: number };
    accepted += body.accepted ?? chunk.length;
  }

  writeSyncState({ lastSyncedAt: nowIso, acceptedRows: accepted, lastError: null, lastAttemptAt: nowIso });
  return { ok: true, accepted };
}
