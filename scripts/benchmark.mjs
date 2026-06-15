#!/usr/bin/env node
// Reproducible agent-economics benchmark from your own local logs.
//
// Indexes this machine (Claude Code + Codex + Gemini) into a throwaway data dir
// and prints outcome-normalized economics: true $/commit, compute $/commit, and
// a per-primary-model breakdown that surfaces the cost-per-outcome inversion.
//
// Emits AGGREGATES ONLY — model names, token sums, commit counts, dollars. No
// prompt text, paths, or transcripts. Safe to paste into a launch post.
//
//   node scripts/benchmark.mjs                 # default drivers ($5/prompt, $0/hr)
//   CODENOMICS_ATTENTION_USD=8 node scripts/benchmark.mjs
//
// Numbers depend on the drivers (attention $/prompt is a user-set assumption)
// and on the commit proxy (see methodology). Report them with those caveats.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.CODENOMICS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-bench-'));

const { runIndex } = await import('../dist/core/engine.js');
const { loadConfig } = await import('../dist/core/config.js');
const { allCollectors } = await import('../dist/collectors/registry.js');
const { aggregate, groupBy } = await import('../dist/core/metrics.js');

const { config } = loadConfig();
const { index, perVendor } = await runIndex(config, allCollectors());
const sessions = index.sessions;

if (!sessions.length) {
  console.log('No sessions found. Use Claude Code / Codex first, or check `codenomics doctor`.');
  process.exit(0);
}

const fmtUsd = (v) => (v === null ? '—' : '$' + v.toFixed(2));
const fmtNum = (v) => v.toLocaleString('en-US');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const overall = aggregate(sessions, config);

console.log('\n=== Codenomics benchmark (your local logs) ===');
console.log(`drivers: attention $${config.drivers.attentionUsdPerPrompt}/prompt · eng $${config.drivers.engHourlyRateUsd}/hr  (user-set assumptions)`);
const span = sessions
  .map((s) => s.endedAt)
  .filter(Boolean)
  .sort((a, b) => a - b);
if (span.length) {
  console.log(`window: ${new Date(span[0]).toISOString().slice(0, 10)} → ${new Date(span[span.length - 1]).toISOString().slice(0, 10)}`);
}
console.log(`vendors: ${Object.entries(perVendor).map(([v, s]) => `${v}=${s.sessions}`).join(' · ')}`);
console.log(`sessions: ${overall.sessions} (${overall.humanSessions}h/${overall.machineSessions}m/${overall.unknownSessions}?) · commits: ${overall.commits} · prompts: ${overall.prompts}\n`);

console.log('OVERALL');
console.log(`  true $/commit   : ${fmtUsd(overall.trueUsdPerCommit)}`);
console.log(`  compute $/commit: ${fmtUsd(overall.costUsdPerCommit)}`);
console.log(`  prompts/commit  : ${overall.promptsPerCommit ?? '—'}`);
console.log(`  compute $ total : ${fmtUsd(overall.costUsd)}  ·  true $ total: ${fmtUsd(overall.trueUsd)}`);
if (overall.unpricedModels.length) console.log(`  unpriced models : ${overall.unpricedModels.join(', ')}`);

// Per-primary-model: this is where the inversion shows (or doesn't).
// Restrict to HUMAN sessions (machine/subagent sessions muddy model choice and
// can mislabel a parent by a dominant subagent model) and require a meaningful
// commit count so a 2-commit cohort can't produce a headline number.
const MIN_COMMITS = Number(process.env.BENCH_MIN_COMMITS ?? 10);
const humanSessions = sessions.filter((s) => s.source === 'human');
const byModel = groupBy(humanSessions, (s) => s.primaryModel ?? '(none)');
const rows = Object.entries(byModel)
  .map(([model, ss]) => ({ model, a: aggregate(ss, config) }))
  .filter((r) => r.a.commits >= MIN_COMMITS)
  .sort((a, b) => (a.a.trueUsdPerCommit ?? Infinity) - (b.a.trueUsdPerCommit ?? Infinity));

console.log(`\nBY PRIMARY MODEL — human sessions, >=${MIN_COMMITS} commits — cheapest true $/commit first`);
console.log(`  ${pad('model', 26)} ${padL('sess', 5)} ${padL('commits', 8)} ${padL('true$/cmt', 10)} ${padL('cmp$/cmt', 9)} ${padL('prompts/cmt', 12)}`);
for (const { model, a } of rows) {
  console.log(`  ${pad(model, 26)} ${padL(a.sessions, 5)} ${padL(a.commits, 8)} ${padL(fmtUsd(a.trueUsdPerCommit), 10)} ${padL(fmtUsd(a.costUsdPerCommit), 9)} ${padL(a.promptsPerCommit ?? '—', 12)}`);
}

if (rows.length >= 2) {
  const cheap = rows[0];
  const dear = rows[rows.length - 1];
  const cheaperPerTok = (m) => m.a.costUsd / Math.max(1, m.a.tokens.output);
  const inversion = cheaperPerTok(cheap) > cheaperPerTok(dear);
  console.log('\nREAD');
  console.log(`  cheapest per commit: ${cheap.model} at ${fmtUsd(cheap.a.trueUsdPerCommit)}`);
  console.log(`  priciest per commit: ${dear.model} at ${fmtUsd(dear.a.trueUsdPerCommit)}`);
  if (inversion) {
    console.log('  ↳ INVERSION PRESENT: the model that costs MORE per token is CHEAPER per commit.');
  } else {
    console.log('  ↳ no per-token inversion in this dataset — report the real ranking, not the headline.');
  }
}
console.log('');
