// Helpers shared by collectors: tolerant JSONL reading, idle-capped activity
// tracking, commit detection, project normalization, recursive file discovery.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { DiscoveredFile } from './types.js';

/**
 * Built-in CLI control/UI slash commands. These reset context, change settings,
 * or show info — they don't ask the agent to do task work, so they should NOT
 * count as interactive prompts (no review attention) and should never be a
 * session's opening recap. Work-driving commands (/init, /review, /pr-comments,
 * /security-review) and any custom user command are NOT here — they count.
 */
const CONTROL_SLASH_COMMANDS = new Set([
  'clear', 'compact', 'config', 'cost', 'doctor', 'exit', 'quit', 'help',
  'hooks', 'ide', 'login', 'logout', 'mcp', 'memory', 'model', 'permissions',
  'privacy-settings', 'resume', 'status', 'statusline', 'terminal-setup',
  'theme', 'upgrade', 'vim', 'output-style', 'add-dir', 'release-notes',
  'bug', 'feedback', 'agents', 'context', 'todos', 'export', 'bashes',
]);

/** True if `name` (without leading slash, lowercased) is a built-in control command. */
export function isControlSlashCommand(name: string): boolean {
  return CONTROL_SLASH_COMMANDS.has(name.replace(/^\//, '').trim().toLowerCase());
}

/**
 * Count real `git commit` invocations in a shell command.
 *
 * The denominator of the headline metric, so it's deliberate about what counts:
 * - splits chained commands (`&&`, `||`, `;`, `|`, newlines) so
 *   `git add . && git commit && git commit` counts as two;
 * - requires `commit` to be the git SUBCOMMAND, not a substring — so
 *   `git log ...commit`, `git show`, `git config commit.template`, `git diff`
 *   do NOT count;
 * - skips git global options/args (`-C dir`, `-c k=v`, `--git-dir=...`);
 * - excludes `--dry-run` (creates no commit).
 *
 * It cannot see exit status (transcripts rarely carry it), so a commit that
 * failed because nothing was staged still counts — a known approximation,
 * documented on the methodology page.
 */
export function countCommits(command: string): number {
  let n = 0;
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    if (isGitCommit(segment)) n++;
  }
  return n;
}

const GIT_GLOBAL_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function isGitCommit(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = tokens.findIndex((t) => t === 'git' || t.endsWith('/git'));
  if (i === -1) return false;
  i++;
  // skip git's own global options (and their values) to reach the subcommand
  while (i < tokens.length && tokens[i]!.startsWith('-')) {
    i += GIT_GLOBAL_OPTS_WITH_ARG.has(tokens[i]!) ? 2 : 1;
  }
  if (tokens[i] !== 'commit') return false;
  return !tokens.slice(i + 1).includes('--dry-run');
}

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
