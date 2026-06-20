import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { personalTrend } from '../dist/server/trend.js';

const WEEK = 7 * 86_400_000;
const NOW = 60 * WEEK; // fixed "now" so bucketing is deterministic

const session = (over = {}) => ({
  schemaVersion: 1, vendor: 'claude-code', id: 's', source: 'human',
  project: '/p', projectPath: '/p', startedAt: 0, endedAt: NOW, wallMs: 0, activeMs: 600_000,
  counts: { userPrompts: 0, assistantTurns: 0, toolCalls: 0, commits: 0, sidechainCalls: 0 },
  toolCounts: {},
  models: { 'claude-fable-5': { calls: 1, input: 1000, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 } },
  primaryModel: 'claude-fable-5', meta: {}, ...over,
});
const counts = (userPrompts, commits) => ({ userPrompts, assistantTurns: 0, toolCalls: 0, commits, sidechainCalls: 0 });
const ppc = (t) => t.metrics.find((m) => m.key === 'promptsPerCommit');

test('personalTrend: 8-week series, current vs own median, direction', () => {
  const sessions = [
    session({ id: 'recent', endedAt: NOW - 0.5 * WEEK, counts: counts(10, 10) }), // prompts/commit = 1, bucket idx 7
    session({ id: 'older', endedAt: NOW - 2.5 * WEEK, counts: counts(50, 10) }),  // prompts/commit = 5, bucket idx 5
  ];
  const t = personalTrend(sessions, DEFAULT_CONFIG, NOW);
  assert.equal(t.weeks, 8);
  assert.equal(t.metrics.length, 4);
  const m = ppc(t);
  assert.equal(m.series.length, 8);
  assert.equal(m.series[5], 5);
  assert.equal(m.series[7], 1);
  assert.equal(m.current, 1);
  assert.equal(m.median, 3);
  assert.equal(m.direction, 'better'); // lower prompts/commit is better
  assert.ok(m.deltaFrac < 0);
  assert.equal(t.weeksWithData, 2);
  assert.equal(t.enough, true);
});

test('personalTrend: a single week of data is "not enough" to read a trend', () => {
  const t = personalTrend([session({ endedAt: NOW - 0.5 * WEEK, counts: counts(4, 2) })], DEFAULT_CONFIG, NOW);
  assert.equal(t.weeksWithData, 1);
  assert.equal(t.enough, false);
});

test('personalTrend: sessions outside the trailing window are dropped', () => {
  const t = personalTrend([session({ endedAt: NOW - 20 * WEEK, counts: counts(4, 2) })], DEFAULT_CONFIG, NOW);
  assert.equal(t.weeksWithData, 0);
  assert.equal(t.enough, false);
});
