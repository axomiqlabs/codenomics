// Indexing engine: discovers vendor log files, parses them incrementally
// (mtime+size cache keyed `${vendor}:${path}`, invalidated by parserVersion),
// quarantines per-file failures so one bad file never kills a run, and rolls
// up drift stats for `doctor`.

import { isSelfRecapSession, SCHEMA_VERSION, primaryModelOf, type IndexFileV1, type SessionV1 } from './schema.js';
import type { CodenomicsConfig } from './config.js';
import type { Collector } from '../collectors/types.js';
import { cachePath, ensureDataDir, readJson, writeIndex, writeJson } from './store.js';
import path from 'node:path';

interface CacheEntry {
  sig: string;
  parserVersion: number;
  sessions?: SessionV1[];
  error?: string;
  drift?: Record<string, number>;
}

type CacheFile = Record<string, CacheEntry>;

export interface VendorRunStats {
  files: number;
  parsed: number;
  fromCache: number;
  errors: number;
  sessions: number;
  drift: Record<string, number>;
}

export interface QuarantinedFile {
  vendor: string;
  path: string;
  error: string;
}

export interface IndexRunResult {
  index: IndexFileV1;
  perVendor: Record<string, VendorRunStats>;
  quarantine: QuarantinedFile[];
}

function mergeDrift(into: Record<string, number>, from: Record<string, number> | undefined): void {
  if (!from) return;
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v;
}

export async function runIndex(
  cfg: CodenomicsConfig,
  collectors: Collector[],
  opts: { vendor?: string; now?: number } = {},
): Promise<IndexRunResult> {
  ensureDataDir();
  const cache = readJson<CacheFile>(cachePath(), {});
  const newCache: CacheFile = {};
  const sessions: SessionV1[] = [];
  const perVendor: Record<string, VendorRunStats> = {};
  const quarantine: QuarantinedFile[] = [];

  for (const collector of collectors) {
    const vcfg = cfg.collectors[collector.vendor];
    if (vcfg && vcfg.enabled === false) continue;
    if (opts.vendor && collector.vendor !== opts.vendor) continue;

    const stats: VendorRunStats = { files: 0, parsed: 0, fromCache: 0, errors: 0, sessions: 0, drift: {} };
    perVendor[collector.vendor] = stats;

    const roots = vcfg?.root ? [path.resolve(vcfg.root)] : collector.defaultRoots();
    const files = await collector.discover(roots);

    for (const f of files) {
      stats.files++;
      const key = `${collector.vendor}:${f.path}`;
      const sig = `${f.mtimeMs}:${f.size}`;
      const hit = cache[key];

      if (hit && hit.sig === sig && hit.parserVersion === collector.parserVersion) {
        newCache[key] = hit;
        stats.fromCache++;
        if (hit.sessions) {
          sessions.push(...hit.sessions);
          stats.sessions += hit.sessions.length;
        }
        if (hit.error) {
          stats.errors++;
          quarantine.push({ vendor: collector.vendor, path: f.path, error: hit.error });
        }
        mergeDrift(stats.drift, hit.drift);
        continue;
      }

      try {
        const result = await collector.parseFile(f.path);
        newCache[key] = {
          sig,
          parserVersion: collector.parserVersion,
          ...(result.sessions.length ? { sessions: result.sessions } : {}),
          ...(Object.keys(result.driftStats).length ? { drift: result.driftStats } : {}),
        };
        sessions.push(...result.sessions);
        stats.sessions += result.sessions.length;
        stats.parsed++;
        mergeDrift(stats.drift, result.driftStats);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // quarantine: recorded so we don't retry until the file changes
        newCache[key] = { sig, parserVersion: collector.parserVersion, error };
        stats.errors++;
        stats.parsed++;
        quarantine.push({ vendor: collector.vendor, path: f.path, error });
      }
    }
  }

  // entries for vendors skipped this run (e.g. --vendor filter) must survive
  if (opts.vendor) {
    for (const [key, entry] of Object.entries(cache)) {
      if (!key.startsWith(`${opts.vendor}:`) && !newCache[key]) {
        newCache[key] = entry;
        if (entry.sessions) sessions.push(...entry.sessions);
      }
    }
  }

  const merged = reclassifySelfRecaps(foldSubagentSessions(sessions));
  merged.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const index: IndexFileV1 = { schemaVersion: SCHEMA_VERSION, generatedAt: opts.now ?? Date.now(), sessions: merged };

  writeJson(cachePath(), newCache);
  writeIndex(index);
  writeJson(diagnosticsPath(), { at: index.generatedAt, perVendor, quarantine });

  return { index, perVendor, quarantine };
}

/**
 * Reclassify codenomics' own `claude -p` recap-generation runs from `human` to
 * `machine`. The collector reads their `entrypoint` as `cli` and would tag them
 * human, but they are self-generated overhead: counting them inflates human
 * stats, re-summarizing them wastes API spend, and their `firstPrompt` (the
 * recap prompt itself) leaks into the dashboard as a recap. As `machine` they
 * contribute $0 attention/time, are excluded from recap candidates, and render
 * as "automated · no prompt" — while their compute cost stays visible.
 *
 * Like `foldSubagentSessions`, this never mutates inputs (they alias the cache);
 * a reclassified session is replaced with a shallow clone.
 */
export function reclassifySelfRecaps(sessions: SessionV1[]): SessionV1[] {
  return sessions.map((s) =>
    s.source === 'human' && isSelfRecapSession(s) ? { ...s, source: 'machine' as const } : s,
  );
}

/**
 * Fold subagent transcript sessions (ext.claudeCode.parentSessionId) into
 * their parent: token usage, tool calls, and commits roll up; the subagent's
 * API calls count as the parent's sidechain calls. Active/wall time is NOT
 * added (subagents run inside the parent's span). Orphans stay standalone.
 *
 * IMPORTANT: this never mutates its inputs. The session objects passed in are
 * shared by reference with the persisted per-file cache; mutating a parent in
 * place would be written back to cache.json and re-folded on every subsequent
 * index, inflating subagent tokens without bound. Parents that receive a fold
 * are deep-cloned first so the cached (raw, unfolded) objects stay pristine.
 */
export function foldSubagentSessions(sessions: SessionV1[]): SessionV1[] {
  // Which parents actually receive a subagent? Only those get cloned.
  const foldsByParentKey = new Map<string, SessionV1[]>();
  const sessionByKey = new Map<string, SessionV1>();
  for (const s of sessions) sessionByKey.set(`${s.vendor}:${s.id}`, s);
  for (const s of sessions) {
    const parentId = (s.ext?.claudeCode as { parentSessionId?: string } | undefined)?.parentSessionId;
    if (!parentId) continue;
    const parentKey = `${s.vendor}:${parentId}`;
    const parent = sessionByKey.get(parentKey);
    if (!parent || parent === s) continue; // orphan or self → stays standalone
    (foldsByParentKey.get(parentKey) ?? foldsByParentKey.set(parentKey, []).get(parentKey)!).push(s);
  }

  const out: SessionV1[] = [];
  for (const s of sessions) {
    const key = `${s.vendor}:${s.id}`;
    // a folded subagent is absorbed into its parent: drop it from the output
    const parentId = (s.ext?.claudeCode as { parentSessionId?: string } | undefined)?.parentSessionId;
    if (parentId) {
      const parent = sessionByKey.get(`${s.vendor}:${parentId}`);
      if (parent && parent !== s) continue;
    }

    const folds = foldsByParentKey.get(key);
    if (!folds) {
      out.push(s); // untouched: safe to share the reference, never mutated
      continue;
    }

    // clone the parent before accumulating so cached objects stay raw
    const parent = cloneSession(s);
    for (const sub of folds) {
      for (const [model, u] of Object.entries(sub.models)) {
        const pm = (parent.models[model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 });
        pm.calls += u.calls;
        pm.input += u.input;
        pm.output += u.output;
        pm.cacheRead += u.cacheRead;
        pm.cacheWrite5m += u.cacheWrite5m;
        pm.cacheWrite1h += u.cacheWrite1h;
        pm.reasoning += u.reasoning;
      }
      parent.counts.sidechainCalls += Object.values(sub.models).reduce((a, m) => a + m.calls, 0);
      parent.counts.toolCalls += sub.counts.toolCalls;
      if (sub.counts.commits) parent.counts.commits = (parent.counts.commits ?? 0) + sub.counts.commits;
      for (const [tool, n] of Object.entries(sub.toolCounts)) {
        parent.toolCounts[tool] = (parent.toolCounts[tool] || 0) + n;
      }
    }
    // primary model may have shifted after folding
    parent.primaryModel = primaryModelOf(parent.models) ?? parent.primaryModel;
    out.push(parent);
  }
  return out;
}

/** Deep-clone the mutable fields a fold touches; other fields can be shared. */
function cloneSession(s: SessionV1): SessionV1 {
  const models: SessionV1['models'] = {};
  for (const [k, m] of Object.entries(s.models)) models[k] = { ...m };
  return { ...s, counts: { ...s.counts }, toolCounts: { ...s.toolCounts }, models };
}

export function diagnosticsPath(): string {
  return path.join(path.dirname(cachePath()), 'diagnostics.json');
}

export interface Diagnostics {
  at: number;
  perVendor: Record<string, VendorRunStats>;
  quarantine: QuarantinedFile[];
}

export function readDiagnostics(): Diagnostics | null {
  return readJson<Diagnostics | null>(diagnosticsPath(), null);
}
