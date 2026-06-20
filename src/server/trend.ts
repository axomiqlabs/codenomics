// Personal trend — "you vs your own past", computed 100% locally from the same
// money-math as the dashboard (core/metrics aggregate), bucketed into trailing
// weeks. Needs NO cloud, NO other contributors, NO k-anonymity gate — so it gives
// a solo user value at n=1 while the cross-org benchmark (which is a network
// feature) fills in. See .claude/plans/benchmark-seed-and-unit-split.md (P0).

import type { SessionV1 } from '../core/schema.js';
import type { CodenomicsConfig } from '../core/config.js';
import { aggregate, type Aggregate } from '../core/metrics.js';

const WEEK_MS = 7 * 86_400_000;
const WEEKS = 8;

interface TrendMetricDef {
  key: keyof Aggregate;
  label: string;
  format: 'usd' | 'num' | 'pct';
  lowerIsBetter: boolean;
}

// The personal headline metrics. True $/commit is the punchline (compute + human);
// compute $/commit is the naive number; the other two are structural efficiency.
const TREND_METRICS: TrendMetricDef[] = [
  { key: 'trueUsdPerCommit', label: 'True $/commit', format: 'usd', lowerIsBetter: true },
  { key: 'costUsdPerCommit', label: 'Compute $/commit', format: 'usd', lowerIsBetter: true },
  { key: 'promptsPerCommit', label: 'Prompts / commit', format: 'num', lowerIsBetter: true },
  { key: 'cacheReadShare', label: 'Cache-read share', format: 'pct', lowerIsBetter: false },
];

export interface TrendMetric {
  key: string;
  label: string;
  format: string;
  lowerIsBetter: boolean;
  /** one value per trailing week, oldest..newest; null when that week had no basis. */
  series: (number | null)[];
  current: number | null;
  median: number | null;
  /** signed fractional change of current vs median (e.g. -0.18 = 18% lower). */
  deltaFrac: number | null;
  direction: 'better' | 'worse' | 'flat' | null;
}

export interface PersonalTrend {
  weeks: number;
  /** epoch-ms start of each trailing week, oldest..newest. */
  weekStarts: number[];
  /** true once enough weeks have data to read a trend (>=2). */
  enough: boolean;
  weeksWithData: number;
  metrics: TrendMetric[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Build the trailing-8-week personal trend. Pure over (sessions, cfg, now). */
export function personalTrend(sessions: SessionV1[], cfg: CodenomicsConfig, now = Date.now()): PersonalTrend {
  const buckets: SessionV1[][] = Array.from({ length: WEEKS }, () => []);
  const weekStarts = Array.from({ length: WEEKS }, (_, i) => now - (WEEKS - i) * WEEK_MS);
  for (const s of sessions) {
    const t = s.endedAt ?? s.startedAt ?? 0;
    const ageWeeks = Math.floor((now - t) / WEEK_MS);
    if (ageWeeks < 0 || ageWeeks >= WEEKS) continue;
    buckets[WEEKS - 1 - ageWeeks]!.push(s);
  }
  const aggs = buckets.map((b) => (b.length ? aggregate(b, cfg) : null));

  // a week "has data" if at least one metric resolved to a number
  let weeksWithData = 0;
  for (const a of aggs) {
    if (a && TREND_METRICS.some((m) => typeof a[m.key] === 'number')) weeksWithData++;
  }

  const metrics: TrendMetric[] = TREND_METRICS.map((m) => {
    const series = aggs.map((a) => (a && typeof a[m.key] === 'number' ? (a[m.key] as number) : null));
    const present = series.filter((v): v is number => v !== null);
    const med = median(present);
    // current = most recent week that has a value
    let current: number | null = null;
    for (let i = series.length - 1; i >= 0; i--) { if (series[i] !== null) { current = series[i]!; break; } }
    let deltaFrac: number | null = null;
    let direction: TrendMetric['direction'] = null;
    if (current !== null && med !== null && med !== 0) {
      deltaFrac = (current - med) / Math.abs(med);
      const improved = m.lowerIsBetter ? current < med : current > med;
      direction = Math.abs(deltaFrac) < 0.02 ? 'flat' : improved ? 'better' : 'worse';
    }
    return { key: m.key, label: m.label, format: m.format, lowerIsBetter: m.lowerIsBetter, series, current, median: med, deltaFrac, direction };
  });

  return { weeks: WEEKS, weekStarts, enough: weeksWithData >= 2, weeksWithData, metrics };
}
