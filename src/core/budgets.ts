// Budget/limit evaluation. Limits live in config (`limits: [...]`); each is
// checked against sessions whose end time falls in the current calendar
// window (local time — this is a local-first tool). Statuses feed the
// dashboard strip, reports, and `index --check-budgets` (nonzero exit).

import type { CodenomicsConfig, LimitConfig } from './config.js';
import { deriveCosts } from './metrics.js';
import { totalTokens, type SessionV1 } from './schema.js';

export type BudgetState = 'ok' | 'warning' | 'breached';

export interface BudgetStatus {
  limit: LimitConfig;
  windowStart: number;
  windowEnd: number;
  used: number;
  max: number;
  ratio: number;
  state: BudgetState;
}

export const WARNING_RATIO = 0.8;

export function windowFor(period: LimitConfig['period'], now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  switch (period) {
    case 'day':
      end.setDate(end.getDate() + 1);
      break;
    case 'week': {
      // ISO week: Monday start
      const dow = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - dow);
      end.setTime(start.getTime());
      end.setDate(end.getDate() + 7);
      break;
    }
    case 'month':
      start.setDate(1);
      end.setTime(start.getTime());
      end.setMonth(end.getMonth() + 1);
      break;
  }
  return { start, end };
}

function inScope(s: SessionV1, scope: string): boolean {
  if (scope === 'global') return true;
  if (scope.startsWith('project:')) return s.project === scope.slice('project:'.length);
  if (scope.startsWith('vendor:')) return s.vendor === scope.slice('vendor:'.length);
  return false;
}

function metricValue(s: SessionV1, metric: LimitConfig['metric'], cfg: CodenomicsConfig): number {
  switch (metric) {
    case 'costUsd':
      return deriveCosts(s, cfg).costUsd;
    case 'trueUsd':
      return deriveCosts(s, cfg).trueUsd;
    case 'tokensIn':
      return Object.values(s.models).reduce((a, m) => a + m.input, 0);
    case 'tokensOut':
      return Object.values(s.models).reduce((a, m) => a + m.output, 0);
    case 'tokensTotal':
      return Object.values(s.models).reduce((a, m) => a + totalTokens(m), 0);
  }
}

export function evaluateBudgets(sessions: SessionV1[], cfg: CodenomicsConfig, now: Date = new Date()): BudgetStatus[] {
  return cfg.limits.map((limit) => {
    const { start, end } = windowFor(limit.period, now);
    let used = 0;
    for (const s of sessions) {
      const t = s.endedAt ?? s.startedAt;
      if (t === null || t < start.getTime() || t >= end.getTime()) continue;
      if (!inScope(s, limit.scope)) continue;
      used += metricValue(s, limit.metric, cfg);
    }
    const ratio = used / limit.max;
    const state: BudgetState = ratio >= 1 ? 'breached' : ratio >= WARNING_RATIO ? 'warning' : 'ok';
    return {
      limit,
      windowStart: start.getTime(),
      windowEnd: end.getTime(),
      used: Math.round(used * 10000) / 10000,
      max: limit.max,
      ratio: Math.round(ratio * 10000) / 10000,
      state,
    };
  });
}
