// Helpers shared by collectors: tolerant JSONL reading, idle-capped activity
// tracking, commit detection, project normalization, recursive file discovery.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { DiscoveredFile } from './types.js';

export const COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/;

/** gaps longer than this don't count as active time */
export const IDLE_CAP_MS = 5 * 60 * 1000;

export class ActivityTracker {
  firstTs: number | null = null;
  lastTs: number | null = null;
  private prevTs: number | null = null;
  activeMs = 0;

  observe(iso: string | undefined): void {
    if (!iso) return;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return;
    if (this.firstTs === null) this.firstTs = t;
    if (this.lastTs === null || t > this.lastTs) this.lastTs = t;
    if (this.prevTs !== null && t > this.prevTs) this.activeMs += Math.min(t - this.prevTs, IDLE_CAP_MS);
    this.prevTs = t;
  }

  get wallMs(): number {
    return this.firstTs !== null && this.lastTs !== null ? this.lastTs - this.firstTs : 0;
  }
}

/** Yield parsed JSON objects line by line; malformed lines are counted, not thrown. */
export async function* readJsonlObjects(
  filePath: string,
  onBadLine?: () => void,
): AsyncGenerator<Record<string, unknown>> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        yield v as Record<string, unknown>;
      } else {
        onBadLine?.();
      }
    } catch {
      onBadLine?.();
    }
  }
}

/** Normalize a working directory into a stable, readable project key. */
export function projectKeyFromPath(p: string): string {
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

/** Recursively find files matching a predicate (depth-first, tolerant of unreadable dirs). */
export function findFiles(root: string, match: (name: string) => boolean): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && match(ent.name)) {
        try {
          const st = fs.statSync(full);
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // raced deletion: skip
        }
      }
    }
  }
  return out;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}
