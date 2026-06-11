// Indexing engine: discovers vendor log files, parses them incrementally
// (mtime+size cache keyed `${vendor}:${path}`, invalidated by parserVersion),
// quarantines per-file failures so one bad file never kills a run, and rolls
// up drift stats for `doctor`.

import { SCHEMA_VERSION, type IndexFileV1, type SessionV1 } from './schema.js';
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

  sessions.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const index: IndexFileV1 = { schemaVersion: SCHEMA_VERSION, generatedAt: opts.now ?? Date.now(), sessions };

  writeJson(cachePath(), newCache);
  writeIndex(index);
  writeJson(diagnosticsPath(), { at: index.generatedAt, perVendor, quarantine });

  return { index, perVendor, quarantine };
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
