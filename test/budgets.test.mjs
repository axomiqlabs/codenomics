import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { evaluateBudgets, windowFor } from '../dist/core/budgets.js';

const usage = (over = {}) => ({ calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, ...over });

function sessionAt(endedAt, over = {}) {
  return {
    schemaVersion: 1,
    vendor: 'claude-code',
    id: Math.random().toString(36).slice(2),
    source: 'machine', // no attention $, keeps math simple
    project: '/p',
    projectPath: '/p',
    startedAt: endedAt - 1000,
    endedAt,
    wallMs: 1000,
    activeMs: 1000,
    counts: { userPrompts: 0, assistantTurns: 1, toolCalls: 0, commits: 0, sidechainCalls: 0 },
    toolCounts: {},
    models: { 'claude-fable-5': usage({ input: 1_000_000 }) }, // $10 compute
    primaryModel: 'claude-fable-5',
    meta: {},
    ...over,
  };
}

const cfgWith = (limits) => ({ ...DEFAULT_CONFIG, limits });

test('windowFor: day, ISO week (Monday), month boundaries', () => {
  const now = new Date(2026, 5, 11, 15, 30); // Thu Jun 11 2026, local
  const day = windowFor('day', now);
  assert.equal(day.start.getDate(), 11);
  assert.equal(day.end.getDate(), 12);
  const week = windowFor('week', now);
  assert.equal(week.start.getDay(), 1); // Monday
  assert.equal(week.start.getDate(), 8);
  assert.equal(week.end.getDate(), 15);
  const month = windowFor('month', now);
  assert.equal(month.start.getDate(), 1);
  assert.equal(month.start.getMonth(), 5);
  assert.equal(month.end.getMonth(), 6);
});

test('budgets: only sessions inside the window count', () => {
  const now = new Date(2026, 5, 11, 12, 0);
  const today = sessionAt(new Date(2026, 5, 11, 9, 0).getTime());
  const yesterday = sessionAt(new Date(2026, 5, 10, 9, 0).getTime());
  const [status] = evaluateBudgets([today, yesterday], cfgWith([{ id: 'd', metric: 'costUsd', period: 'day', max: 100, scope: 'global' }]), now);
  assert.equal(status.used, 10);
  assert.equal(status.state, 'ok');
});

test('budgets: warning at >=80%, breached at >=100%', () => {
  const now = new Date(2026, 5, 11, 12, 0);
  const s = sessionAt(new Date(2026, 5, 11, 9, 0).getTime());
  const states = (max) =>
    evaluateBudgets([s], cfgWith([{ id: 'd', metric: 'costUsd', period: 'day', max, scope: 'global' }]), now)[0].state;
  assert.equal(states(100), 'ok');
  assert.equal(states(12.5), 'warning'); // 10/12.5 = 0.8
  assert.equal(states(10), 'breached');
});

test('budgets: project and vendor scopes filter sessions', () => {
  const now = new Date(2026, 5, 11, 12, 0);
  const a = sessionAt(new Date(2026, 5, 11, 9, 0).getTime(), { project: '/a' });
  const b = sessionAt(new Date(2026, 5, 11, 9, 0).getTime(), { project: '/b', vendor: 'codex' });
  const statuses = evaluateBudgets(
    [a, b],
    cfgWith([
      { id: 'p', metric: 'costUsd', period: 'day', max: 100, scope: 'project:/a' },
      { id: 'v', metric: 'costUsd', period: 'day', max: 100, scope: 'vendor:codex' },
    ]),
    now,
  );
  assert.equal(statuses[0].used, 10);
  assert.equal(statuses[1].used, 10);
});

test('budgets: window end is exclusive (session at windowEnd excluded)', () => {
  const now = new Date(2026, 5, 11, 12, 0);
  const { end } = windowFor('day', now);
  const atEnd = sessionAt(end.getTime()); // exactly midnight tomorrow
  const justBefore = sessionAt(end.getTime() - 1);
  const [status] = evaluateBudgets(
    [atEnd, justBefore],
    cfgWith([{ id: 'd', metric: 'costUsd', period: 'day', max: 100, scope: 'global' }]),
    now,
  );
  assert.equal(status.used, 10); // only justBefore counts
});

test('budgets: trueUsd metric includes attention for human sessions', () => {
  const now = new Date(2026, 5, 11, 12, 0);
  const cfg = { ...DEFAULT_CONFIG, drivers: { attentionUsdPerPrompt: 5, engHourlyRateUsd: 0 } };
  const s = sessionAt(new Date(2026, 5, 11, 9, 0).getTime(), {
    source: 'human',
    counts: { userPrompts: 4, assistantTurns: 1, toolCalls: 0, commits: 0, sidechainCalls: 0 },
  });
  const [status] = evaluateBudgets(
    [s],
    { ...cfg, limits: [{ id: 't', metric: 'trueUsd', period: 'day', max: 100, scope: 'global' }] },
    now,
  );
  assert.equal(status.used, 30); // $10 compute + 4×$5 attention
});

test('budgets: token metrics', () => {
  const now = new Date(2026, 5, 11, 12, 0);
  const s = sessionAt(new Date(2026, 5, 11, 9, 0).getTime(), {
    models: { m: usage({ input: 100, output: 50, cacheRead: 1000 }) },
  });
  const statuses = evaluateBudgets(
    [s],
    cfgWith([
      { id: 'in', metric: 'tokensIn', period: 'day', max: 1e9, scope: 'global' },
      { id: 'out', metric: 'tokensOut', period: 'day', max: 1e9, scope: 'global' },
      { id: 'tot', metric: 'tokensTotal', period: 'day', max: 1e9, scope: 'global' },
    ]),
    now,
  );
  assert.equal(statuses[0].used, 100);
  assert.equal(statuses[1].used, 50);
  assert.equal(statuses[2].used, 1150);
});
