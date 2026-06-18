// Single source of truth for the running CLI's version, a tiny zero-dep semver
// compare, and the version headers every cloud request carries. Used by the
// update notifier (is a newer release out?) and by the sync/signup clients (so
// the server can gate or nudge an out-of-date CLI). See update-check.ts and the
// server's version-gate.ts for the two consumers.

import { readFileSync } from 'node:fs';

/** Header the server reads to identify the client's version (see version-gate.ts). */
export const VERSION_HEADER = 'x-codenomics-version';

let cached: string | null = null;

/** The running CLI's version, read once from the bundled package.json.
 *  `../../package.json` resolves the same from dist/core/*.js and dist/cli/*.js
 *  (both are two levels under the package root). Falls back to 0.0.0. */
export function cliVersion(): string {
  if (cached !== null) return cached;
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

/** Parse "1.2.3" / "1.2.3-rc.1" -> [1,2,3]. Prerelease tags are dropped (we only
 *  ever ask "is a newer STABLE out?", so pre-release ordering isn't modeled).
 *  Returns null when the core isn't three numeric parts. */
export function parseVersion(v: string): [number, number, number] | null {
  const core = String(v).trim().replace(/^v/, '').split(/[-+]/, 1)[0]!;
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** a > b by [major, minor, patch]. Unparseable inputs are treated as not-newer
 *  (false) so a bad version string can never trigger a spurious upgrade nudge. */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return true;
    if (pa[i]! < pb[i]!) return false;
  }
  return false;
}

/** The headers every cloud request carries, so the backend can identify the
 *  client version (telemetry + the upgrade gate). Plain ASCII; no PII. */
export function clientHeaders(): Record<string, string> {
  const v = cliVersion();
  return { 'user-agent': `codenomics/${v}`, [VERSION_HEADER]: v };
}
