import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { geminiCollector } from '../dist/collectors/gemini.js';
import { splitJsonObjects } from '../dist/collectors/gemini.js';

const FIX = new URL('./fixtures/gemini/', import.meta.url).pathname;

test('gemini: pretty-printed flat records, multiple sessions per file', async () => {
  const { sessions, driftStats } = await geminiCollector.parseFile(path.join(FIX, 'telemetry.log'));
  assert.equal(sessions.length, 2);
  const a = sessions.find((s) => s.id === 'sess-aaa');
  const b = sessions.find((s) => s.id === 'sess-bbb');

  assert.equal(a.counts.userPrompts, 1);
  assert.equal(a.counts.toolCalls, 1);
  assert.equal(a.counts.assistantTurns, 2);
  assert.equal(a.counts.commits, null); // capability-gated
  assert.equal(a.source, 'unknown');
  // input excludes cached; cacheRead carries it
  assert.equal(a.models['gemini-2.5-pro'].input, 1000);
  assert.equal(a.models['gemini-2.5-pro'].cacheRead, 200);
  assert.equal(a.models['gemini-2.5-pro'].output, 350);
  assert.equal(a.models['gemini-2.5-pro'].reasoning, 80);
  assert.equal(a.models['gemini-2.5-flash'].input, 500);
  assert.equal(a.primaryModel, 'gemini-2.5-pro');
  assert.equal(a.toolCounts.run_shell_command, 1);

  assert.equal(b.counts.userPrompts, 1);
  assert.equal(b.models['gemini-2.5-pro'].input, 700);

  assert.deepEqual(driftStats, { 'unknown-event:gemini_cli.brand_new_event': 1 });
});

test('gemini: batched OTLP envelope with kv-array attributes', async () => {
  const { sessions } = await geminiCollector.parseFile(path.join(FIX, 'collector-otlp.log'));
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, 'sess-otlp');
  assert.equal(s.counts.userPrompts, 1);
  assert.equal(s.counts.toolCalls, 1);
  assert.equal(s.models['gemini-2.5-pro'].input, 1500);
  assert.equal(s.models['gemini-2.5-pro'].cacheRead, 500);
  assert.equal(s.models['gemini-2.5-pro'].output, 400);
  assert.ok(s.startedAt > 0);
});

test('gemini: splitJsonObjects handles braces in strings and truncated tails', () => {
  const objs = [...splitJsonObjects('{"a":"}{"}  {"b":2}\n{"trunc')];
  assert.deepEqual(objs, [{ a: '}{' }, { b: 2 }]);
});

test('gemini: garbage file yields no sessions, no throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gem-'));
  const p = path.join(dir, 'telemetry.log');
  fs.writeFileSync(p, 'not json at all {{{ ]]] ');
  const { sessions } = await geminiCollector.parseFile(p);
  assert.equal(sessions.length, 0);
});
