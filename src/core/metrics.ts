// Derived economics. Sessions store tokens only; everything money-shaped is
// computed here from config (pricing + drivers) so changes apply instantly.
//
// Drivers are user-set inputs to the canned metrics (the "attention $/prompt"
// idea, generalized). Adding a driver = one DRIVER_DEFS entry + consuming it
// in annotateSession/aggregate.

import type { CodenomicsConfig } from './config.js';
import { usageCostUsd } from './pricing.js';
import { totalTokens, type SessionV1 } from './schema.js';

export interface DriverDef {
  key: keyof CodenomicsConfig['drivers'];
  label: string;
  description: string;
  unit: string;
  default: number;
}

export const DRIVER_DEFS: DriverDef[] = [
  {
    key: 'attentionUsdPerPrompt',
    label: 'Attention $/prompt',
    description:
      'Dollar value of the human attention each interactive prompt consumes (context switch + review). Machine sessions contribute $0.',
    unit: '$/prompt',
    default: 5,
  },
  {
    key: 'engHourlyRateUsd',
    label: 'Engineer $/hour',
    description:
      'Optional loaded hourly cost. When > 0, active supervision time of human sessions is added to true cost.',
    unit: '$/hour',
    default: 0,
  },
];

export interface DerivedCosts {
  /** API-equivalent compute $ across all priced models */
  costUsd: number;
  /** human attention $ (drivers.attentionUsdPerPrompt x prompts; human sessions only) */
  attentionUsd: number;
  /** active-time $ (drivers.engHourlyRateUsd; human sessions only) */
  timeUsd: number;
  /** costUsd + attentionUsd + timeUsd — the number that matters */
  trueUsd: number;
  /** models we had no pricing for (their tokens contributed $0) */
  unpricedModels: string[];
}

export type DerivedSession = SessionV1 & { derived: DerivedCosts };

export function deriveCosts(s: SessionV1, cfg: CodenomicsConfig): DerivedCosts {
  let costUsd = 0;
  const unpricedModels: string[] = [];
  for (const [model, usage] of Object.entries(s.models)) {
    const c = usageCostUsd(model, usage, cfg);
    if (c === null) unpricedModels.push(model);
    else costUsd += c;
  }
  const isMachine = s.source === 'machine';
  const attentionUsd = isMachine ? 0 : s.counts.userPrompts * cfg.drivers.attentionUsdPerPrompt;
  const timeUsd = isMachine ? 0 : (s.activeMs / 3_600_000) * cfg.drivers.engHourlyRateUsd;
  return {
    costUsd: round4(costUsd),
    attentionUsd: round4(attentionUsd),
    timeUsd: round4(timeUsd),
    trueUsd: round4(costUsd + attentionUsd + timeUsd),
    unpricedModels,
  };
}

export function annotateSession(s: SessionV1, cfg: CodenomicsConfig): DerivedSession {
  return { ...s, derived: deriveCosts(s, cfg) };
}

export interface Aggregate {
  sessions: number;
  humanSessions: number;
  machineSessions: number;
  costUsd: number;
  attentionUsd: number;
  timeUsd: number;
  trueUsd: number;
  prompts: number;
  commits: number;
  toolCalls: number;
  activeMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** (compute$ + attention$ + time$) / commits — the punchline. null when no commits. */
  trueUsdPerCommit: number | null;
  costUsdPerCommit: number | null;
  promptsPerCommit: number | null;
  usdPerActiveHour: number | null;
  /** share of all input-side tokens served from cache */
  cacheReadShare: number | null;
  unpricedModels: string[];
}

export function aggregate(sessions: SessionV1[], cfg: CodenomicsConfig): Aggregate {
  const agg: Aggregate = {
    sessions: 0,
    humanSessions: 0,
    machineSessions: 0,
    costUsd: 0,
    attentionUsd: 0,
    timeUsd: 0,
    trueUsd: 0,
    prompts: 0,
    commits: 0,
    toolCalls: 0,
    activeMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    trueUsdPerCommit: null,
    costUsdPerCommit: null,
    promptsPerCommit: null,
    usdPerActiveHour: null,
    cacheReadShare: null,
    unpricedModels: [],
  };
  const unpriced = new Set<string>();

  for (const s of sessions) {
    const d = deriveCosts(s, cfg);
    agg.sessions++;
    if (s.source === 'machine') agg.machineSessions++;
    else agg.humanSessions++;
    agg.costUsd += d.costUsd;
    agg.attentionUsd += d.attentionUsd;
    agg.timeUsd += d.timeUsd;
    agg.trueUsd += d.trueUsd;
    agg.prompts += s.counts.userPrompts;
    agg.commits += s.counts.commits ?? 0;
    agg.toolCalls += s.counts.toolCalls;
    agg.activeMs += s.activeMs;
    for (const m of Object.values(s.models)) {
      agg.tokens.input += m.input;
      agg.tokens.output += m.output;
      agg.tokens.cacheRead += m.cacheRead;
      agg.tokens.cacheWrite += m.cacheWrite5m + m.cacheWrite1h;
      agg.tokens.total += totalTokens(m);
    }
    for (const u of d.unpricedModels) unpriced.add(u);
  }

  agg.costUsd = round4(agg.costUsd);
  agg.attentionUsd = round4(agg.attentionUsd);
  agg.timeUsd = round4(agg.timeUsd);
  agg.trueUsd = round4(agg.trueUsd);
  if (agg.commits > 0) {
    agg.trueUsdPerCommit = round4(agg.trueUsd / agg.commits);
    agg.costUsdPerCommit = round4(agg.costUsd / agg.commits);
    agg.promptsPerCommit = round4(agg.prompts / agg.commits);
  }
  if (agg.activeMs > 0) agg.usdPerActiveHour = round4(agg.trueUsd / (agg.activeMs / 3_600_000));
  const inputSide = agg.tokens.input + agg.tokens.cacheRead;
  if (inputSide > 0) agg.cacheReadShare = round4(agg.tokens.cacheRead / inputSide);
  agg.unpricedModels = [...unpriced].sort();
  return agg;
}

export function groupBy<K extends string>(sessions: SessionV1[], keyOf: (s: SessionV1) => K): Record<K, SessionV1[]> {
  const out = {} as Record<K, SessionV1[]>;
  for (const s of sessions) {
    (out[keyOf(s)] ??= []).push(s);
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
