import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeCollector } from '../dist/collectors/claude-code.js';

const FIX = new URL('./fixtures/claude-code/', import.meta.url).pathname;

for (const name of ['human-commits', 'machine-sdk', 'slash-command']) {
  test(`claude-code golden: ${name}`, async () => {
    const result = await claudeCodeCollector.parseFile(path.join(FIX, `${name}.jsonl`));
    const expected = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.expected.json`), 'utf8'));
    assert.deepEqual(result, expected);
  });
}

test('claude-code: control slash commands (/clear) are not prompts; custom commands are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-'));
  const p = path.join(dir, 'session.jsonl');
  const userCmd = (name) => JSON.stringify({
    type: 'user', timestamp: '2026-01-01T00:00:00.000Z', entrypoint: 'cli',
    message: { role: 'user', content: `<command-name>${name}</command-name><command-message>x</command-message>` },
  });
  const userText = (t) => JSON.stringify({
    type: 'user', timestamp: '2026-01-01T00:00:01.000Z', entrypoint: 'cli',
    message: { role: 'user', content: t },
  });
  fs.writeFileSync(p, [
    userCmd('/clear'),          // control: ignored
    userCmd('/compact'),        // control: ignored
    userText('fix the parser'), // real prompt
    userCmd('/deploy'),         // custom command: counts
  ].join('\n'));
  const { sessions } = await claudeCodeCollector.parseFile(p);
  const s = sessions[0];
  assert.equal(s.counts.userPrompts, 2);            // real prompt + /deploy, not /clear or /compact
  assert.equal(s.meta.firstPrompt, 'fix the parser'); // recap is the real prompt, not /clear
  assert.equal(s.meta.slashCommand, '/deploy');     // only the work command is recorded
});

test('claude-code: model name normalization strips [1m] and date suffix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccn-'));
  const p = path.join(dir, 'session.jsonl');
  const ev = (model) => JSON.stringify({
    type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', entrypoint: 'cli',
    message: { id: 'id-' + model, model, usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
  });
  // dated, [1m]-marked, and dated+[1m] must all collapse to one key
  fs.writeFileSync(p, [
    ev('claude-opus-4-8'),
    ev('claude-opus-4-8-20260115'),
    ev('claude-opus-4-8[1m]'),
    ev('claude-opus-4-8-20260115[1m]'),
  ].join('\n'));
  const { sessions } = await claudeCodeCollector.parseFile(p);
  assert.deepEqual(Object.keys(sessions[0].models), ['claude-opus-4-8']);
  assert.equal(sessions[0].models['claude-opus-4-8'].calls, 4);
});

test('claude-code: entrypoint drives source', async () => {
  const human = await claudeCodeCollector.parseFile(path.join(FIX, 'human-commits.jsonl'));
  const machine = await claudeCodeCollector.parseFile(path.join(FIX, 'machine-sdk.jsonl'));
  assert.equal(human.sessions[0].source, 'human');
  assert.equal(machine.sessions[0].source, 'machine');
});

test('claude-code: streamed usage dedup keeps last per message.id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-'));
  const p = path.join(dir, 'session.jsonl');
  const ev = (usage) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      entrypoint: 'cli',
      message: { id: 'msg_1', model: 'claude-test-1', usage, content: [] },
    });
  fs.writeFileSync(
    p,
    [
      ev({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }),
      ev({ input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100 }), // streamed growth: keep this
    ].join('\n'),
  );
  const { sessions } = await claudeCodeCollector.parseFile(p);
  const m = sessions[0].models['claude-test-1'];
  assert.equal(m.calls, 1);
  assert.equal(m.output, 50);
  assert.equal(m.cacheRead, 100);
});

test('claude-code: old cache_creation format assumed 5m', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-'));
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    p,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { id: 'm1', model: 'claude-test-1', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 777 }, content: [] },
    }),
  );
  const { sessions } = await claudeCodeCollector.parseFile(p);
  assert.equal(sessions[0].models['claude-test-1'].cacheWrite5m, 777);
});

test('claude-code: tolerates garbage and unknown types', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-'));
  const p = path.join(dir, 'session.jsonl');
  const good = fs.readFileSync(path.join(FIX, 'slash-command.jsonl'), 'utf8');
  fs.writeFileSync(p, 'garbage{{{\n{"type":"new-fangled-thing"}\n' + good);
  const { sessions, driftStats } = await claudeCodeCollector.parseFile(p);
  assert.equal(sessions.length, 1);
  assert.ok(driftStats['malformed-line'] >= 1);
  assert.ok(driftStats['unknown-type:new-fangled-thing'] >= 1);
});
