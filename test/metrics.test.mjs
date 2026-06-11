import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { priceFor, usageCostUsd } from '../dist/core/pricing.js';
import { deriveCosts, aggregate } from '../dist/core/metrics.js';

const usage = (over = {}) => ({ calls: 1, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, ...over });

const session = (over = {}) => ({
  schemaVersion: 1,
  vendor: 'claude-code',
  id: 's1',
  source: 'human',
  project: '/p',
  projectPath: '/p',
  startedAt: 0,
  endedAt: 3_600_000,
  wallMs: 3_600_000,
  activeMs: 1_800_000, // 30 min
  counts: { userPrompts: 4, assistantTurns: 10, toolCalls: 20, commits: 2, sidechainCalls: 0 },
  toolCounts: {},
  models: { 'claude-fable-5': usage({ input: 1_000_000, output: 100_000 }) },
  primaryModel: 'claude-fable-5',
  meta: {},
  ...over,
});

test('pricing: builtin resolution, date suffix and [1m] stripped', () => {
  assert.equal(priceFor('claude-haiku-4-5-20251001', DEFAULT_CONFIG).inUsd, 1);
  assert.equal(priceFor('claude-opus-4-8[1m]', DEFAULT_CONFIG).inUsd, 5);
  assert.equal(priceFor('claude-opus-4-1', DEFAULT_CONFIG).inUsd, 15);
});

test('pricing: longest-prefix beats shorter (gpt-5-mini vs gpt-5)', () => {
  assert.equal(priceFor('gpt-5-mini-2026-01', DEFAULT_CONFIG).inUsd, 0.25);
  assert.equal(priceFor('gpt-5.5', DEFAULT_CONFIG).inUsd, 1.25);
});

test('pricing: family fallback and unknown model', () => {
  assert.equal(priceFor('claude-sonnet-9-0', DEFAULT_CONFIG).inUsd, 3);
  assert.equal(priceFor('mystery-model-x', DEFAULT_CONFIG), null);
});

test('pricing: config override wins over builtin and fills cache defaults', () => {
  const cfg = { ...DEFAULT_CONFIG, pricing: { 'claude-fable-5': { in: 20, out: 100 } } };
  const p = priceFor('claude-fable-5', cfg);
  assert.equal(p.inUsd, 20);
  assert.equal(p.cacheReadUsd, 2); // 0.1x in
  assert.equal(p.cacheWrite5mUsd, 25); // 1.25x in
});

test('pricing: anthropic cache math matches the original indexer formula', () => {
  // 1M in + 0.1M out + 2M cacheRead + 0.5M cw5m + 0.2M cw1h on fable (10/50)
  const u = usage({ input: 1e6, output: 1e5, cacheRead: 2e6, cacheWrite5m: 5e5, cacheWrite1h: 2e5 });
  const c = usageCostUsd('claude-fable-5', u, DEFAULT_CONFIG);
  const expected = (1e6 * 10 + 1e5 * 50 + 2e6 * 10 * 0.1 + 5e5 * 10 * 1.25 + 2e5 * 10 * 2) / 1e6;
  assert.ok(Math.abs(c - expected) < 1e-9);
});

test('deriveCosts: attention and hourly apply to human sessions only', () => {
  const cfg = { ...DEFAULT_CONFIG, drivers: { attentionUsdPerPrompt: 5, engHourlyRateUsd: 100 } };
  const human = deriveCosts(session(), cfg);
  // compute: 1M*$10 + 0.1M*$50 = 10 + 5 = 15
  assert.equal(human.costUsd, 15);
  assert.equal(human.attentionUsd, 20); // 4 prompts x $5
  assert.equal(human.timeUsd, 50); // 0.5h x $100
  assert.equal(human.trueUsd, 85);

  const machine = deriveCosts(session({ source: 'machine' }), cfg);
  assert.equal(machine.attentionUsd, 0);
  assert.equal(machine.timeUsd, 0);
  assert.equal(machine.trueUsd, machine.costUsd);
});

test('deriveCosts: unpriced models contribute $0 and are reported', () => {
  const s = session({ models: { 'mystery-model-x': usage({ input: 1e6, output: 1e6 }) } });
  const d = deriveCosts(s, DEFAULT_CONFIG);
  assert.equal(d.costUsd, 0);
  assert.deepEqual(d.unpricedModels, ['mystery-model-x']);
});

test('aggregate: true $/commit is (compute + attention + time) / commits', () => {
  const cfg = { ...DEFAULT_CONFIG, drivers: { attentionUsdPerPrompt: 5, engHourlyRateUsd: 0 } };
  const sessions = [
    session(), // $15 compute + $20 attention, 2 commits
    session({ id: 's2', source: 'machine', counts: { userPrompts: 9, assistantTurns: 1, toolCalls: 1, commits: 1, sidechainCalls: 0 } }), // $15 compute, no attention, 1 commit
  ];
  const a = aggregate(sessions, cfg);
  assert.equal(a.commits, 3);
  assert.equal(a.trueUsd, 50);
  assert.equal(a.trueUsdPerCommit, 16.6667); // 50/3 rounded to 4dp
  assert.equal(a.promptsPerCommit, 4.3333); // 13/3 rounded to 4dp
  assert.equal(a.humanSessions, 1);
  assert.equal(a.machineSessions, 1);
});

test('aggregate: null commit counts (capability-gated) do not poison totals', () => {
  const a = aggregate([session({ counts: { userPrompts: 1, assistantTurns: 1, toolCalls: 1, commits: null, sidechainCalls: 0 } })], DEFAULT_CONFIG);
  assert.equal(a.commits, 0);
  assert.equal(a.trueUsdPerCommit, null);
});

test('aggregate: cacheReadShare', () => {
  const s = session({ models: { 'claude-fable-5': usage({ input: 1e6, cacheRead: 9e6 }) } });
  const a = aggregate([s], DEFAULT_CONFIG);
  assert.equal(a.cacheReadShare, 0.9);
});
