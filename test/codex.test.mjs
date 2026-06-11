import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexCollector } from '../dist/collectors/codex.js';

const FIX = new URL('./fixtures/codex/', import.meta.url).pathname;

for (const name of ['human-commits', 'subagent', 'small-nullinfo']) {
  test(`codex golden: ${name}`, async () => {
    const result = await codexCollector.parseFile(path.join(FIX, `${name}.jsonl`));
    const expected = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.expected.json`), 'utf8'));
    assert.deepEqual(result, expected);
  });
}

test('codex: source detection', async () => {
  const human = await codexCollector.parseFile(path.join(FIX, 'human-commits.jsonl'));
  const machine = await codexCollector.parseFile(path.join(FIX, 'subagent.jsonl'));
  assert.equal(human.sessions[0].source, 'human');
  assert.equal(machine.sessions[0].source, 'machine');
});

test('codex: per-turn usage reconciles with final cumulative totals', async () => {
  // re-emitted token_count events (unchanged cumulative) must not double-count
  const lines = fs.readFileSync(path.join(FIX, 'human-commits.jsonl'), 'utf8').split('\n').filter(Boolean);
  let final = null;
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.info) {
      final = e.payload.info.total_token_usage;
    }
  }
  const { sessions } = await codexCollector.parseFile(path.join(FIX, 'human-commits.jsonl'));
  const m = sessions[0].models['gpt-5.5'];
  assert.equal(m.input + m.cacheRead, final.input_tokens);
  assert.equal(m.output, final.output_tokens);
  assert.equal(m.reasoning, final.reasoning_output_tokens);
});

function tmpFile(content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-')), 'rollout-test.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

test('codex: tolerates garbage lines, unknown events, truncation', async () => {
  const good = fs.readFileSync(path.join(FIX, 'small-nullinfo.jsonl'), 'utf8');
  const mangled =
    'this is not json\n' +
    '{"type":"some_future_event","payload":{"type":"whatever"}}\n' +
    '[1,2,3]\n' +
    good +
    good.slice(0, Math.floor(good.length / 3)); // truncated mid-line tail
  const { sessions, driftStats } = await codexCollector.parseFile(tmpFile(mangled));
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].counts.userPrompts >= 2);
  assert.ok(driftStats['malformed-line'] >= 1);
  assert.ok(driftStats['unknown-type:some_future_event'] >= 1);
});

test('codex: empty/meta-only file yields no session', async () => {
  const { sessions } = await codexCollector.parseFile(
    tmpFile('{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"x","cwd":"/tmp"}}\n'),
  );
  assert.equal(sessions.length, 0);
});

test('codex: counter-reset clamp on totals-only stream', async () => {
  const ev = (input, cached, output) =>
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } } },
    });
  const lines = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-test', cwd: '/tmp' } }),
    ev(1000, 200, 50), // first turn
    ev(1500, 300, 80), // +500/+100/+30
    ev(400, 100, 20), //  RESET (post-compaction): treat as +400/+100/+20
  ].join('\n');
  const { sessions } = await codexCollector.parseFile(tmpFile(lines));
  const m = sessions[0].models['gpt-test'];
  assert.equal(m.input + m.cacheRead, 1000 + 500 + 400);
  assert.equal(m.cacheRead, 200 + 100 + 100);
  assert.equal(m.output, 50 + 30 + 20);
});
