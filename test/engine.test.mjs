import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FIX = new URL('./fixtures/claude-code/', import.meta.url).pathname;

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-data-'));
  process.env.CODENOMICS_DATA_DIR = dir;
  return dir;
}

async function load() {
  // import after env is set; modules read env lazily via functions so order is safe
  const { runIndex } = await import('../dist/core/engine.js');
  const { DEFAULT_CONFIG } = await import('../dist/core/config.js');
  const { claudeCodeCollector } = await import('../dist/collectors/claude-code.js');
  return { runIndex, DEFAULT_CONFIG, claudeCodeCollector };
}

function cfgWithRoot(DEFAULT_CONFIG, root) {
  return {
    ...DEFAULT_CONFIG,
    collectors: { 'claude-code': { enabled: true, root }, codex: { enabled: false }, gemini: { enabled: false } },
  };
}

test('engine: indexes, then serves from cache, and invalidates on parserVersion bump', async () => {
  freshEnv();
  const { runIndex, DEFAULT_CONFIG, claudeCodeCollector } = await load();
  const cfg = cfgWithRoot(DEFAULT_CONFIG, FIX);

  const r1 = await runIndex(cfg, [claudeCodeCollector], { now: 1000 });
  assert.equal(r1.perVendor['claude-code'].parsed, 3);
  assert.equal(r1.perVendor['claude-code'].fromCache, 0);
  assert.equal(r1.index.sessions.length, 3);
  assert.equal(r1.index.generatedAt, 1000);

  const r2 = await runIndex(cfg, [claudeCodeCollector], { now: 2000 });
  assert.equal(r2.perVendor['claude-code'].parsed, 0);
  assert.equal(r2.perVendor['claude-code'].fromCache, 3);
  assert.equal(r2.index.sessions.length, 3);

  const bumped = { ...claudeCodeCollector, parserVersion: claudeCodeCollector.parserVersion + 1 };
  const r3 = await runIndex(cfg, [bumped], { now: 3000 });
  assert.equal(r3.perVendor['claude-code'].parsed, 3);
});

test('engine: quarantines throwing files without killing the run', async () => {
  freshEnv();
  const { runIndex, DEFAULT_CONFIG, claudeCodeCollector } = await load();
  const cfg = cfgWithRoot(DEFAULT_CONFIG, FIX);

  let calls = 0;
  const flaky = {
    ...claudeCodeCollector,
    async parseFile(p) {
      calls++;
      if (p.endsWith('machine-sdk.jsonl')) throw new Error('boom');
      return claudeCodeCollector.parseFile(p);
    },
  };

  const r1 = await runIndex(cfg, [flaky], { now: 1000 });
  assert.equal(r1.index.sessions.length, 2);
  assert.equal(r1.quarantine.length, 1);
  assert.match(r1.quarantine[0].error, /boom/);

  // second run: quarantined file not retried (file unchanged), still reported
  const callsAfterFirst = calls;
  const r2 = await runIndex(cfg, [flaky], { now: 2000 });
  assert.equal(calls, callsAfterFirst);
  assert.equal(r2.quarantine.length, 1);
});

test('engine: disabled vendor is skipped', async () => {
  freshEnv();
  const { runIndex, DEFAULT_CONFIG, claudeCodeCollector } = await load();
  const cfg = {
    ...DEFAULT_CONFIG,
    collectors: { 'claude-code': { enabled: false } },
  };
  const r = await runIndex(cfg, [claudeCodeCollector], { now: 1000 });
  assert.equal(r.index.sessions.length, 0);
  assert.equal(r.perVendor['claude-code'], undefined);
});
