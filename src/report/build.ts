// Report builder: index + config -> ReportModel (structured blocks).
// Renderers (md/html/slack) consume the same model so numbers can't diverge.
// weekly = last complete ISO week (or the week containing --at);
// monthly = last complete calendar month (or the month containing --at).

import type { CodenomicsConfig } from '../core/config.js';
import { aggregate, groupBy, type Aggregate } from '../core/metrics.js';
import { evaluateBudgets } from '../core/budgets.js';
import { deriveCosts } from '../core/metrics.js';
import type { SessionV1 } from '../core/schema.js';
import { usageCostUsd } from '../core/pricing.js';

export type ReportBlock =
  | { kind: 'kpis'; items: Array<{ label: string; value: string; delta?: string }> }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][] }
  | { kind: 'chart'; title: string; days: Array<{ day: string; usd: number }> }
  | { kind: 'callouts'; severity: 'info' | 'warn' | 'breach'; title: string; lines: string[] }
  | { kind: 'prose'; title: string; lines: string[] };

export interface ReportModel {
  title: string;
  periodLabel: string;
  fileStem: string; // e.g. 2026-W23 or 2026-06
  generatedAt: number;
  start: number;
  end: number;
  blocks: ReportBlock[];
}

export type Period = 'weekly' | 'monthly';

function startOfISOWeek(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function isoWeekLabel(start: Date): string {
  // ISO week number of the Thursday in this week
  const thu = new Date(start);
  thu.setDate(thu.getDate() + 3);
  const jan1 = new Date(thu.getFullYear(), 0, 1);
  const week = Math.ceil(((thu.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${thu.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function periodWindow(period: Period, at?: Date, now: Date = new Date()): { start: Date; end: Date; label: string; stem: string } {
  if (period === 'weekly') {
    const anchor = at ?? new Date(now.getTime() - 7 * 86_400_000); // last complete week by default
    const start = startOfISOWeek(anchor);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const stem = isoWeekLabel(start);
    return { start, end, label: `week ${stem} (${start.toISOString().slice(0, 10)} – ${new Date(end.getTime() - 1).toISOString().slice(0, 10)})`, stem };
  }
  const anchor = at ?? new Date(now.getFullYear(), now.getMonth(), 0); // last day of previous month
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  const stem = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return { start, end, label: `month ${stem}`, stem };
}

const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(2)}k` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`);
const usdP = (v: number) => (v >= 10 ? `$${v.toFixed(1)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const tok = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v)));
const mins = (ms: number) => {
  const m = ms / 60_000;
  return m >= 90 ? `${(m / 60).toFixed(1)}h` : `${m.toFixed(0)}m`;
};

function delta(cur: number | null, prev: number | null, lowerIsBetter = false): string | undefined {
  if (cur === null || prev === null || prev === 0) return undefined;
  const pct = ((cur - prev) / prev) * 100;
  if (!Number.isFinite(pct)) return undefined;
  const arrow = pct > 2 ? (lowerIsBetter ? '▲' : '↑') : pct < -2 ? (lowerIsBetter ? '▼' : '↓') : '→';
  return `${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs prior`;
}

function inWindow(s: SessionV1, start: number, end: number): boolean {
  const t = s.endedAt ?? s.startedAt;
  return t !== null && t >= start && t < end;
}

function famOf(model: string): string {
  for (const f of ['fable', 'opus', 'sonnet', 'haiku', 'gemini']) if (model.includes(f)) return f;
  if (model.includes('gpt')) return 'gpt';
  return 'other';
}

const perCommit = (a: Aggregate) => (a.trueUsdPerCommit !== null ? usdP(a.trueUsdPerCommit) : '—');

export function buildReport(
  sessions: SessionV1[],
  cfg: CodenomicsConfig,
  period: Period,
  at?: Date,
  now: Date = new Date(),
): ReportModel {
  const win = periodWindow(period, at, now);
  const startMs = win.start.getTime();
  const endMs = win.end.getTime();
  const span = endMs - startMs;
  const rows = sessions.filter((s) => inWindow(s, startMs, endMs));
  const prevRows = sessions.filter((s) => inWindow(s, startMs - span, startMs));
  const a = aggregate(rows, cfg);
  const p = aggregate(prevRows, cfg);
  const blocks: ReportBlock[] = [];

  // --- KPIs with prior-period deltas ---
  blocks.push({
    kind: 'kpis',
    items: [
      { label: 'TRUE $/COMMIT', value: perCommit(a), delta: delta(a.trueUsdPerCommit, p.trueUsdPerCommit, true) },
      { label: 'true cost', value: usd(a.trueUsd), delta: delta(a.trueUsd, p.trueUsd, true) },
      { label: 'compute $ (API-equiv)', value: usd(a.costUsd), delta: delta(a.costUsd, p.costUsd, true) },
      { label: 'commits', value: String(a.commits), delta: delta(a.commits, p.commits) },
      { label: 'sessions', value: `${a.sessions} (${a.humanSessions}h/${a.machineSessions}m)`, delta: delta(a.sessions, p.sessions) },
      { label: 'prompts', value: String(a.prompts), delta: delta(a.prompts, p.prompts) },
      { label: 'active time', value: mins(a.activeMs), delta: delta(a.activeMs, p.activeMs) },
      { label: 'cache hit', value: a.cacheReadShare !== null ? `${(a.cacheReadShare * 100).toFixed(1)}%` : '—', delta: delta(a.cacheReadShare, p.cacheReadShare) },
    ],
  });

  // --- budget callouts ---
  const budgets = evaluateBudgets(sessions, cfg, new Date(Math.min(endMs - 1, now.getTime())));
  const breaches = budgets.filter((b) => b.state !== 'ok');
  if (breaches.length) {
    blocks.push({
      kind: 'callouts',
      severity: breaches.some((b) => b.state === 'breached') ? 'breach' : 'warn',
      title: 'Budget status',
      lines: breaches.map(
        (b) => `${b.state === 'breached' ? 'BREACHED' : 'warning'}: ${b.limit.id} at ${(b.ratio * 100).toFixed(0)}% (${b.used} / ${b.max} ${b.limit.metric}, ${b.limit.period}, ${b.limit.scope})`,
      ),
    });
  }
  if (a.unpricedModels.length) {
    blocks.push({
      kind: 'callouts',
      severity: 'warn',
      title: 'Unpriced models (contributed $0 — fix via config pricing)',
      lines: a.unpricedModels,
    });
  }

  // --- spend by vendor ---
  const byVendor = groupBy(rows, (s) => s.vendor);
  blocks.push({
    kind: 'table',
    title: 'By agent',
    columns: ['agent', 'sessions', 'compute $', 'true $', 'commits', 'true $/commit', 'prompts/commit'],
    rows: Object.entries(byVendor).map(([vendor, ss]) => {
      const g = aggregate(ss, cfg);
      return [vendor, String(g.sessions), usd(g.costUsd), usd(g.trueUsd), String(g.commits), perCommit(g), g.promptsPerCommit !== null ? g.promptsPerCommit.toFixed(1) : '—'];
    }),
  });

  // --- spend by model family, best true $/commit first ---
  const byFam = groupBy(rows, (s) => famOf(s.primaryModel ?? ''));
  const famRows = Object.entries(byFam)
    .map(([fam, ss]) => ({ fam, g: aggregate(ss, cfg) }))
    .sort((x, y) => (x.g.trueUsdPerCommit ?? Infinity) - (y.g.trueUsdPerCommit ?? Infinity));
  blocks.push({
    kind: 'table',
    title: 'Model economics (lower true $/commit wins)',
    columns: ['model', 'true $/commit', 'sessions', 'compute $', 'commits', 'prompts/commit', 'out tok'],
    rows: famRows.map(({ fam, g }) => [fam, perCommit(g), String(g.sessions), usd(g.costUsd), String(g.commits), g.promptsPerCommit !== null ? g.promptsPerCommit.toFixed(1) : '—', tok(g.tokens.output)]),
  });

  // --- top projects ---
  const byProj = groupBy(rows, (s) => s.project);
  const projRows = Object.entries(byProj)
    .map(([proj, ss]) => ({ proj, g: aggregate(ss, cfg) }))
    .sort((x, y) => y.g.trueUsd - x.g.trueUsd)
    .slice(0, 10);
  blocks.push({
    kind: 'table',
    title: 'Top projects by true cost',
    columns: ['project', 'true $', 'compute $', 'sessions', 'commits', 'true $/commit'],
    rows: projRows.map(({ proj, g }) => [proj, usd(g.trueUsd), usd(g.costUsd), String(g.sessions), String(g.commits), perCommit(g)]),
  });

  // --- daily chart ---
  const byDay = new Map<string, number>();
  for (const s of rows) {
    const t = s.endedAt ?? s.startedAt;
    if (t === null) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + deriveCosts(s, cfg).trueUsd);
  }
  blocks.push({
    kind: 'chart',
    title: 'Daily true $',
    days: [...byDay.entries()].sort().map(([day, v]) => ({ day, usd: Math.round(v * 100) / 100 })),
  });

  // --- top sessions ---
  const top = rows
    .map((s) => ({ s, d: deriveCosts(s, cfg) }))
    .sort((x, y) => y.d.trueUsd - x.d.trueUsd)
    .slice(0, 10);
  blocks.push({
    kind: 'table',
    title: 'Top sessions by true cost',
    columns: ['when', 'agent', 'model', 'project', 'prompts', 'commits', 'compute $', 'true $'],
    rows: top.map(({ s, d }) => [
      new Date(s.endedAt ?? 0).toISOString().slice(0, 16).replace('T', ' '),
      s.vendor,
      s.primaryModel ?? '—',
      s.project,
      String(s.counts.userPrompts),
      s.counts.commits === null ? '—' : String(s.counts.commits),
      usdP(d.costUsd),
      usdP(d.trueUsd),
    ]),
  });

  // --- canned recommendations ---
  blocks.push({ kind: 'prose', title: 'Observations', lines: recommendations(rows, cfg, a) });

  return {
    title: `Codenomics ${period} report`,
    periodLabel: win.label,
    fileStem: win.stem,
    generatedAt: now.getTime(),
    start: startMs,
    end: endMs,
    blocks,
  };
}

function recommendations(rows: SessionV1[], cfg: CodenomicsConfig, a: Aggregate): string[] {
  const out: string[] = [];

  // machine work on premium models: estimate the cheap-model price for the same tokens
  const machine = rows.filter((s) => s.source === 'machine');
  let premiumUsd = 0;
  let cheapUsd = 0;
  for (const s of machine) {
    for (const [model, u] of Object.entries(s.models)) {
      const fam = famOf(model);
      if (fam === 'opus' || fam === 'fable' || fam === 'gpt') {
        premiumUsd += usageCostUsd(model, u, cfg) ?? 0;
        cheapUsd += usageCostUsd('claude-haiku-4-5', u, cfg) ?? 0;
      }
    }
  }
  if (premiumUsd - cheapUsd > 1) {
    out.push(
      `Machine (headless) sessions burned ${usd(premiumUsd)} on premium models; the same tokens at haiku pricing would be ${usd(cheapUsd)}. If output quality holds, that is ${usd(premiumUsd - cheapUsd)} of headroom this period — try routing automated jobs to a cheaper model.`,
    );
  }

  if (a.cacheReadShare !== null && a.cacheReadShare < 0.5 && a.tokens.input > 1e6) {
    out.push(
      `Cache hit rate is ${(a.cacheReadShare * 100).toFixed(0)}% — most input tokens are paid at full price. Long-lived sessions and stable system prompts raise this; check for tooling that breaks prompt-cache continuity.`,
    );
  }

  const bloated = rows.filter((s) => {
    const calls = Object.values(s.models).reduce((x, m) => x + m.calls, 0);
    const cacheRead = Object.values(s.models).reduce((x, m) => x + m.cacheRead, 0);
    return calls > 10 && cacheRead / calls > 300_000;
  });
  if (bloated.length) {
    out.push(
      `${bloated.length} session(s) dragged >300k tokens of context per API call (the session-bloat tax). Splitting long sessions or starting fresh contexts after big explorations cuts this directly.`,
    );
  }

  if (a.promptsPerCommit !== null && a.promptsPerCommit > 15) {
    out.push(
      `${a.promptsPerCommit.toFixed(1)} prompts per commit is high — at $${cfg.drivers.attentionUsdPerPrompt}/prompt of attention that dominates true cost. Bigger, better-specified asks usually beat many small corrections.`,
    );
  }

  if (!out.length) out.push('No obvious inefficiencies this period.');
  return out;
}
