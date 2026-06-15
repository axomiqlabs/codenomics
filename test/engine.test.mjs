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

test('engine: --vendor filter keeps other vendors\' cached sessions in the index', async () => {
  freshEnv();
  const { runIndex, DEFAULT_CONFIG, claudeCodeCollector } = await load();
  // a tiny second collector so the index spans two vendors
  const fakeCodex = {
    vendor: 'codex',
    parserVersion: 1,
    capabilities: { commits: true, activeTime: 'exact', cacheWriteSplit: false, sourceDetection: true, promptText: true },
    defaultRoots: () => ['/nonexistent'],
    discover: async () => [{ path: '/virtual/rollout-1.jsonl', mtimeMs: 1, size: 1 }],
    parseFile: async () => ({
      sessions: [{
        schemaVersion: 1, vendor: 'codex', id: 'cdx-1', source: 'human', project: '/p', projectPath: '/p',
        startedAt: 0, endedAt: 10, wallMs: 10, activeMs: 10,
        counts: { userPrompts: 1, assistantTurns: 1, toolCalls: 0, commits: 0, sidechainCalls: 0 },
        toolCounts: {}, models: {}, primaryModel: null, meta: {},
      }],
      driftStats: {},
    }),
  };
  const cfg = {
    ...DEFAULT_CONFIG,
    collectors: { 'claude-code': { enabled: true, root: FIX }, codex: { enabled: true }, gemini: { enabled: false } },
  };

  const r1 = await runIndex(cfg, [claudeCodeCollector, fakeCodex], { now: 1000 });
  assert.ok(r1.index.sessions.some((s) => s.vendor === 'codex'));
  const claudeCount = r1.index.sessions.filter((s) => s.vendor === 'claude-code').length;

  // re-index ONLY claude-code: codex sessions must survive from cache
  const r2 = await runIndex(cfg, [claudeCodeCollector, fakeCodex], { now: 2000, vendor: 'claude-code' });
  assert.ok(r2.index.sessions.some((s) => s.vendor === 'codex'), 'codex sessions dropped by --vendor reindex');
  assert.equal(r2.index.sessions.filter((s) => s.vendor === 'claude-code').length, claudeCount);
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

test('engine: re-indexing does NOT double-count folded subagent tokens (cache round-trip)', async () => {
  freshEnv();
  const { runIndex, DEFAULT_CONFIG, claudeCodeCollector } = await load();
  const SUB = new URL('./fixtures/cc-subagents/', import.meta.url).pathname;
  const cfg = cfgWithRoot(DEFAULT_CONFIG, SUB);

  const haikuOut = (idx) => idx.sessions.find((s) => s.id === 'PARENT-1')?.models['claude-haiku-4-5']?.output;

  const r1 = await runIndex(cfg, [claudeCodeCollector], { now: 1000 });
  assert.equal(r1.index.sessions.length, 1); // subagent folded into parent
  assert.equal(haikuOut(r1.index), 1000);

  // second + third runs serve the parent and subagent from cache; folding must
  // not mutate the cached objects, so the total stays put (regression: it grew).
  const r2 = await runIndex(cfg, [claudeCodeCollector], { now: 2000 });
  assert.equal(haikuOut(r2.index), 1000);
  const r3 = await runIndex(cfg, [claudeCodeCollector], { now: 3000 });
  assert.equal(haikuOut(r3.index), 1000);
});

test('engine: subagent sessions fold into their parent', async () => {
  freshEnv();
  const { foldSubagentSessions } = await import('../dist/core/engine.js');
  const mk = (id, over = {}) => ({
    schemaVersion: 1, vendor: 'claude-code', id, source: 'human', project: '/p', projectPath: '/p',
    startedAt: 0, endedAt: 1000, wallMs: 1000, activeMs: 500,
    counts: { userPrompts: 2, assistantTurns: 3, toolCalls: 4, commits: 1, sidechainCalls: 0 },
    toolCounts: { Bash: 4 },
    models: { 'claude-fable-5': { calls: 3, input: 100, output: 200, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 } },
    primaryModel: 'claude-fable-5', meta: {}, ...over,
  });
  const parent = mk('parent-1');
  const agent = mk('agent-x', {
    source: 'machine',
    counts: { userPrompts: 0, assistantTurns: 0, toolCalls: 6, commits: 1, sidechainCalls: 0 },
    toolCounts: { Read: 6 },
    models: { 'claude-haiku-4-5': { calls: 5, input: 50, output: 999, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 } },
    primaryModel: 'claude-haiku-4-5',
    ext: { claudeCode: { parentSessionId: 'parent-1' } },
  });
  const orphan = mk('agent-orphan', { ext: { claudeCode: { parentSessionId: 'gone' } } });

  const out = foldSubagentSessions([parent, agent, orphan]);
  assert.equal(out.length, 2); // agent folded, orphan kept
  const p = out.find((s) => s.id === 'parent-1');
  assert.equal(p.models['claude-haiku-4-5'].output, 999);
  assert.equal(p.counts.toolCalls, 10);
  assert.equal(p.counts.commits, 2);
  assert.equal(p.counts.sidechainCalls, 5);
  assert.equal(p.counts.userPrompts, 2); // unchanged: attention is the parent's
  assert.equal(p.activeMs, 500); // unchanged: subagent ran inside the span
  assert.equal(p.primaryModel, 'claude-haiku-4-5'); // recomputed after fold
  assert.ok(out.find((s) => s.id === 'agent-orphan'));
});
