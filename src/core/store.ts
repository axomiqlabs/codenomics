// Data-dir I/O: index, parse cache, summaries, reports. Everything lives under
// the XDG data dir (never inside the package), so global installs work.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import { SCHEMA_VERSION, type IndexFileV1 } from './schema.js';

export function indexPath(): string { return path.join(dataDir(), 'index.json'); }
export function cachePath(): string { return path.join(dataDir(), 'cache.json'); }
export function summariesPath(): string { return path.join(dataDir(), 'summaries.json'); }
export function reportsDir(): string { return path.join(dataDir(), 'reports'); }

export function ensureDataDir(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

export const EMPTY_INDEX: IndexFileV1 = { schemaVersion: SCHEMA_VERSION, generatedAt: 0, sessions: [] };

export function readIndex(): IndexFileV1 {
  const idx = readJson<IndexFileV1>(indexPath(), EMPTY_INDEX);
  if (idx.schemaVersion !== SCHEMA_VERSION) return EMPTY_INDEX; // stale schema: force reindex
  return idx;
}

export function writeIndex(idx: IndexFileV1): void {
  writeJson(indexPath(), idx);
}

export interface SummaryEntry { text: string; at: number; }
export type SummariesFile = Record<string, SummaryEntry>; // keyed by `${vendor}:${sessionId}`

export function readSummaries(): SummariesFile {
  return readJson<SummariesFile>(summariesPath(), {});
}

export function writeSummaries(s: SummariesFile): void {
  writeJson(summariesPath(), s);
}
