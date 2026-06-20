// "How you compare" panel data for the dashboard.
//
// Computes the user's own cohort ratios LOCALLY (same six formulas the cloud
// precompute uses), then asks the cloud for the cohort's percentile breakpoints
// and self-locates the user's value against them. The sync token is used here,
// server-side, and never reaches the browser. All cloud calls are read-only.

import type { CodenomicsConfig } from '../core/config.js';
import type { SessionV1 } from '../core/schema.js';
import { buildRollups } from '../core/rollup.js';

const WINDOW_DAYS = 30;
const FETCH_TIMEOUT_MS = 8000;

interface CohortAgg {
  input: number; output: number; cacheRead: number;
  cacheWrite5m: number; cacheWrite1h: number; reasoning: number;
  sessions: number; prompts: number; commits: number; activeMs: number;
}

function emptyAgg(): CohortAgg {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, sessions: 0, prompts: 0, commits: 0, activeMs: 0 };
}
function addInto(dst: CohortAgg, src: CohortAgg): void {
  dst.input += src.input; dst.output += src.output; dst.cacheRead += src.cacheRead;
  dst.cacheWrite5m += src.cacheWrite5m; dst.cacheWrite1h += src.cacheWrite1h; dst.reasoning += src.reasoning;
  dst.sessions += src.sessions; dst.prompts += src.prompts; dst.commits += src.commits; dst.activeMs += src.activeMs;
}
function totalTokens(a: CohortAgg): number {
  return a.input + a.output + a.cacheRead + a.cacheWrite5m + a.cacheWrite1h;
}

interface MetricDef {
  key: string;
  label: string;
  format: 'num' | 'tok' | 'pct' | 'min';
  lowerIsBetter: boolean;
  value(a: CohortAgg): number | null;
}

// Keys + formulas MUST match the cloud backend's benchmark metric definitions.
const METRICS: MetricDef[] = [
  { key: 'prompts_per_commit', label: 'Prompts / commit', format: 'num', lowerIsBetter: true, value: (a) => (a.commits > 0 ? a.prompts / a.commits : null) },
  { key: 'tokens_per_commit', label: 'Tokens / commit', format: 'tok', lowerIsBetter: true, value: (a) => (a.commits > 0 ? totalTokens(a) / a.commits : null) },
  { key: 'output_per_commit', label: 'Output / commit', format: 'tok', lowerIsBetter: true, value: (a) => (a.commits > 0 ? a.output / a.commits : null) },
  { key: 'cache_read_share', label: 'Cache-read share', format: 'pct', lowerIsBetter: false, value: (a) => (a.input + a.cacheRead > 0 ? a.cacheRead / (a.input + a.cacheRead) : null) },
  { key: 'commits_per_session', label: 'Commits / session', format: 'num', lowerIsBetter: false, value: (a) => (a.sessions > 0 ? a.commits / a.sessions : null) },
  { key: 'active_min_per_commit', label: 'Active min / commit', format: 'min', lowerIsBetter: true, value: (a) => (a.commits > 0 ? a.activeMs / 60_000 / a.commits : null) },
];

interface Breakpoints { p10: number; p25: number; p50: number; p75: number; p90: number }

export interface BenchMetricResult {
  key: string;
  label: string;
  format: string;
  lowerIsBetter: boolean;
  yourValue: number | null;
  status: 'ok' | 'withheld' | 'undefined' | 'error';
  n?: number;
  breakpoints?: Breakpoints;
  percentile?: number | null;
  atFloor?: boolean;
  atCeil?: boolean;
  /** which fallback tier the distribution came from: 0 exact · 1 vendor · 2 all. */
  tier?: number;
  scope?: string;
}

export interface BenchPanel {
  configured: boolean;
  unreachable?: boolean;
  authError?: boolean;
  cohort?: { vendor: string; model: string; source: string; sessions: number; commits: number };
  windowDays?: number;
  metrics?: BenchMetricResult[];
  message?: string;
}

/** Place a value within p10..p90, returning an approximate percentile. */
function locate(v: number, bp: Breakpoints): { percentile: number | null; atFloor: boolean; atCeil: boolean } {
  const pts: Array<[number, number]> = [[10, bp.p10], [25, bp.p25], [50, bp.p50], [75, bp.p75], [90, bp.p90]];
  if (v <= pts[0]![1]) return { percentile: 10, atFloor: true, atCeil: false };
  if (v >= pts[pts.length - 1]![1]) return { percentile: 90, atFloor: false, atCeil: true };
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, v0] = pts[i]!;
    const [p1, v1] = pts[i + 1]!;
    if (v >= v0 && v <= v1) {
      const f = v1 === v0 ? 0 : (v - v0) / (v1 - v0);
      return { percentile: Math.round(p0 + (p1 - p0) * f), atFloor: false, atCeil: false };
    }
  }
  return { percentile: null, atFloor: false, atCeil: false };
}

async function fetchMetric(
  endpoint: string, token: string, m: MetricDef,
  vendor: string, model: string, source: string, aggsByTier: CohortAgg[],
): Promise<{ result: BenchMetricResult; auth?: boolean; netError?: boolean }> {
  // exact-cohort value by default; recomputed at the SERVED tier below so the
  // comparison stays apples-to-apples when the cloud falls back to a broader cohort.
  const base: BenchMetricResult = { key: m.key, label: m.label, format: m.format, lowerIsBetter: m.lowerIsBetter, yourValue: m.value(aggsByTier[0]!), status: 'ok' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({ metric: m.key, vendor, model, source, window: String(WINDOW_DAYS) });
    const res = await fetch(`${endpoint}/v1/benchmark?${qs.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (res.status === 401) return { result: { ...base, status: 'error' }, auth: true };
    if (!res.ok) return { result: { ...base, status: 'error' }, netError: true };
    const body = (await res.json()) as { withheld?: boolean; n?: number; percentiles?: Breakpoints; tier?: number; scope?: string };
    if (body.withheld || !body.percentiles) return { result: { ...base, status: 'withheld' } };
    const tier = typeof body.tier === 'number' && body.tier >= 0 && body.tier < aggsByTier.length ? body.tier : 0;
    const yourValue = m.value(aggsByTier[tier]!); // same breadth as the served distribution
    const breakpoints = body.percentiles;
    if (yourValue === null) return { result: { ...base, yourValue, status: 'undefined', n: body.n, breakpoints, tier, scope: body.scope } };
    const loc = locate(yourValue, breakpoints);
    return { result: { ...base, yourValue, status: 'ok', n: body.n, breakpoints, percentile: loc.percentile, atFloor: loc.atFloor, atCeil: loc.atCeil, tier, scope: body.scope } };
  } catch {
    return { result: { ...base, status: 'error' }, netError: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function benchmarkPanel(sessions: SessionV1[], cfg: CodenomicsConfig): Promise<BenchPanel> {
  const endpoint = (cfg.sync.endpoint ?? '').replace(/\/+$/, '');
  const token = cfg.sync.token ?? process.env.CODENOMICS_SYNC_TOKEN ?? '';
  if (!endpoint || !token) {
    return { configured: false, message: 'Join the benchmark to see how you compare.' };
  }

  const windowStart = Date.now() - WINDOW_DAYS * 86_400_000;
  const inWindow = sessions.filter((s) => (s.endedAt ?? s.startedAt ?? 0) >= windowStart);
  // Reuse the exact rollup shape the cloud ingests, then aggregate per cohort
  // the same way the cloud precompute does — so "your value" is apples-to-apples.
  const byCohort = new Map<string, CohortAgg>();
  for (const r of buildRollups(inWindow)) {
    const key = `${r.vendor}|${r.model}|${r.source}`;
    const a = byCohort.get(key) ?? byCohort.set(key, emptyAgg()).get(key)!;
    a.input += r.tokens.input; a.output += r.tokens.output; a.cacheRead += r.tokens.cacheRead;
    a.cacheWrite5m += r.tokens.cacheWrite5m; a.cacheWrite1h += r.tokens.cacheWrite1h; a.reasoning += r.tokens.reasoning;
    a.sessions += r.sessions; a.prompts += r.prompts; a.commits += r.commits; a.activeMs += r.activeMs;
  }
  if (byCohort.size === 0) {
    return { configured: true, windowDays: WINDOW_DAYS, message: 'No sessions in the last 30 days to compare.' };
  }

  // Primary cohort: prefer human, then cohorts with commits, then most sessions.
  let bestKey: string | null = null;
  let best = -1;
  for (const [key, a] of byCohort) {
    const source = key.split('|')[2]!;
    const score = (source === 'human' ? 1e9 : 0) + (a.commits > 0 ? 1e6 : 0) + a.sessions;
    if (score > best) { best = score; bestKey = key; }
  }
  const key = bestKey!;
  const agg = byCohort.get(key)!;
  const [vendor, model, source] = key.split('|') as [string, string, string];

  // your aggregates at each fallback breadth: T0 exact · T1 all your models for this
  // vendor · T2 all your vendors — so "your value" matches whatever tier the cloud serves.
  const aggT1 = emptyAgg();
  const aggT2 = emptyAgg();
  for (const [k, a] of byCohort) {
    const [v, , s] = k.split('|') as [string, string, string];
    if (s === source) addInto(aggT2, a);
    if (v === vendor && s === source) addInto(aggT1, a);
  }
  const aggsByTier = [agg, aggT1, aggT2];

  const fetched = await Promise.all(
    METRICS.map((m) => fetchMetric(endpoint, token, m, vendor, model, source, aggsByTier)),
  );
  const metrics = fetched.map((f) => f.result);
  const panel: BenchPanel = {
    configured: true,
    windowDays: WINDOW_DAYS,
    cohort: { vendor, model, source, sessions: agg.sessions, commits: agg.commits },
    metrics,
  };
  if (fetched.some((f) => f.auth)) panel.authError = true;
  else if (metrics.every((r) => r.status === 'error')) panel.unreachable = true;
  return panel;
}
