import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../dist/core/config.js';
import { buildReport, periodWindow } from '../dist/report/build.js';
import { renderMarkdown } from '../dist/report/render-md.js';
import { renderHtml } from '../dist/report/render-html.js';
import { buildDigest } from '../dist/report/slack.js';
import { buildRollups } from '../dist/core/rollup.js';

const usage = (over = {}) => ({ calls: 5, input: 100_000, output: 50_000, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0, ...over });

let n = 0;
function sess(endedAt, over = {}) {
  n++;
  return {
    schemaVersion: 1,
    vendor: 'claude-code',
    id: `s${n}`,
    source: 'human',
    project: '/proj/a',
    projectPath: '/proj/a',
    startedAt: endedAt - 600_000,
    endedAt,
    wallMs: 600_000,
    activeMs: 300_000,
    counts: { userPrompts: 5, assistantTurns: 10, toolCalls: 20, commits: 2, sidechainCalls: 0 },
    toolCounts: { Bash: 10 },
    models: { 'claude-fable-5': usage() },
    primaryModel: 'claude-fable-5',
    meta: {},
    ...over,
  };
}

// fixed clock: Thursday 2026-06-11
const NOW = new Date(2026, 5, 11, 12, 0);
const IN_WEEK = new Date(2026, 5, 2, 10, 0).getTime(); // Tue Jun 2 — inside last complete week (Jun 1–7)
const PRIOR_WEEK = new Date(2026, 4, 27, 10, 0).getTime(); // Wed May 27

test('periodWindow: weekly defaults to last complete ISO week', () => {
  const w = periodWindow('weekly', undefined, NOW);
  assert.equal(w.start.getDay(), 1);
  assert.equal(w.start.getDate(), 1); // Mon Jun 1 2026
  assert.equal(w.end.getDate(), 8);
});

test('periodWindow: monthly defaults to last complete month', () => {
  const m = periodWindow('monthly', undefined, NOW);
  assert.equal(m.stem, '2026-05');
});

test('buildReport: sections present, deltas computed, machine-routing recommendation fires', () => {
  const sessions = [
    sess(IN_WEEK),
    sess(IN_WEEK + 3600_000, { source: 'machine', vendor: 'codex', models: { 'gpt-5.5': usage({ input: 1_000_000, output: 500_000, cacheRead: 10_000_000 }) }, primaryModel: 'gpt-5.5', counts: { userPrompts: 1, assistantTurns: 3, toolCalls: 5, commits: 0, sidechainCalls: 0 } }),
    sess(PRIOR_WEEK), // prior period for deltas
  ];
  const model = buildReport(sessions, DEFAULT_CONFIG, 'weekly', undefined, NOW);
  assert.equal(model.fileStem, '2026-W23');
  const kinds = model.blocks.map((b) => b.kind);
  assert.ok(kinds.includes('kpis'));
  assert.ok(kinds.includes('table'));
  assert.ok(kinds.includes('chart'));
  assert.ok(kinds.includes('prose'));

  const kpis = model.blocks.find((b) => b.kind === 'kpis');
  assert.ok(kpis.items.some((i) => i.delta)); // prior data ⇒ deltas exist

  const byAgent = model.blocks.find((b) => b.kind === 'table' && b.title === 'By agent');
  assert.equal(byAgent.rows.length, 2); // claude-code + codex

  const prose = model.blocks.find((b) => b.kind === 'prose');
  assert.ok(prose.lines.some((l) => l.includes('haiku pricing')), `expected machine-routing tip, got: ${prose.lines.join(' | ')}`);
});

test('renderers: markdown and html are stable and well-formed', () => {
  const model = buildReport([sess(IN_WEEK)], DEFAULT_CONFIG, 'weekly', undefined, NOW);
  model.generatedAt = 0; // deterministic snapshot
  const md = renderMarkdown(model);
  assert.ok(md.startsWith('# Codenomics weekly report'));
  assert.ok(md.includes('TRUE $/COMMIT'));
  assert.ok(md.includes('| model |') || md.includes('Model economics'));
  const html = renderHtml(model);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<svg'));
  assert.ok(!html.includes('<script')); // reports are static artifacts
});

test('slack digest is compact and carries the hero metric', () => {
  const model = buildReport([sess(IN_WEEK)], DEFAULT_CONFIG, 'weekly', undefined, NOW);
  const digest = buildDigest(model);
  assert.ok(digest.includes('TRUE $/COMMIT'));
  assert.ok(digest.split('\n').length < 12);
});

test('rollups: aggregates only, no text fields, session counters on primary model', () => {
  const rollups = buildRollups([sess(IN_WEEK, { meta: { firstPrompt: 'SECRET PROMPT' } })]);
  assert.equal(rollups.length, 1);
  const r = rollups[0];
  assert.equal(r.sessions, 1);
  assert.equal(r.prompts, 5);
  assert.equal(r.commits, 2);
  assert.ok(!JSON.stringify(rollups).includes('SECRET'));
});

test('rollups: multi-model session attaches counters to the primary row only (no double count)', () => {
  const s = sess(IN_WEEK, {
    models: {
      'claude-fable-5': usage({ output: 10 }), // not primary
      'claude-opus-4-8': usage({ output: 999 }), // primary (most output)
    },
    primaryModel: 'claude-opus-4-8',
  });
  const rollups = buildRollups([s]);
  assert.equal(rollups.length, 2); // one row per model
  const byModel = Object.fromEntries(rollups.map((r) => [r.model, r]));
  // session/prompt/commit counters land on exactly the primary model's row
  assert.equal(byModel['claude-opus-4-8'].sessions, 1);
  assert.equal(byModel['claude-opus-4-8'].prompts, 5);
  assert.equal(byModel['claude-opus-4-8'].commits, 2);
  assert.equal(byModel['claude-fable-5'].sessions, 0);
  assert.equal(byModel['claude-fable-5'].prompts, 0);
  assert.equal(byModel['claude-fable-5'].commits, 0);
  // totals across rows are not inflated
  assert.equal(rollups.reduce((a, r) => a + r.commits, 0), 2);
});
