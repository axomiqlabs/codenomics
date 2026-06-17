import test from 'node:test';
import assert from 'node:assert/strict';
import { hashProject, buildPayload } from '../dist/core/sync-client.js';

function session(over = {}) {
  return {
    schemaVersion: 1,
    vendor: 'claude-code',
    id: 'x',
    source: 'human',
    project: '/home/me/secret-project',
    projectPath: '/home/me/secret-project',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_000,
    wallMs: 1000,
    activeMs: 1000,
    counts: { userPrompts: 3, assistantTurns: 1, toolCalls: 0, commits: 2, sidechainCalls: 0 },
    toolCounts: {},
    models: { 'claude-opus-4-8': { calls: 1, input: 100, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 } },
    primaryModel: 'claude-opus-4-8',
    meta: {},
    ...over,
  };
}

test('hashProject: deterministic, salt-sensitive, 64-hex', () => {
  const a = hashProject('/home/me/p', 's1');
  const b = hashProject('/home/me/p', 's1');
  const c = hashProject('/home/me/p', 's2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('buildPayload: project is hashed (raw path never present), counts preserved', () => {
  const rows = buildPayload([session()], 'salt');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.match(r.project, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rows).includes('secret-project'));
  assert.equal(r.commits, 2);
  assert.equal(r.prompts, 3);
  assert.equal(r.tokens.input, 100);
});
