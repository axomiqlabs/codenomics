import test from 'node:test';
import assert from 'node:assert/strict';
import { countCommits, ActivityTracker, projectKeyFromPath, IDLE_CAP_MS } from '../dist/collectors/shared.js';

test('countCommits: counts real commits, not substrings', () => {
  assert.equal(countCommits('git commit -m "fix"'), 1);
  assert.equal(countCommits('git -C /repo commit -m x'), 1);
  assert.equal(countCommits('git -c user.name=bot commit -m x'), 1);
  assert.equal(countCommits('/usr/bin/git commit'), 1);
});

test('countCommits: excludes read-only/config subcommands and dry-run', () => {
  assert.equal(countCommits('git log --format=%H -- commit'), 0); // "commit" is an arg, not the subcommand
  assert.equal(countCommits('git show HEAD --format=commit'), 0);
  assert.equal(countCommits('git config commit.template ~/.gitmessage'), 0);
  assert.equal(countCommits('git diff --stat'), 0);
  assert.equal(countCommits('git commit --dry-run'), 0); // creates nothing
  assert.equal(countCommits('git rev-parse HEAD'), 0);
});

test('countCommits: counts each commit in a chained command', () => {
  assert.equal(countCommits('git add . && git commit -m a && git commit -m b'), 2);
  assert.equal(countCommits('git add -A; git commit -m x'), 1);
  assert.equal(countCommits('echo hi && ls'), 0);
});

test('countCommits: a commit message mentioning git commit is still one', () => {
  assert.equal(countCommits('git commit -m "revert the git commit from yesterday"'), 1);
});

test('ActivityTracker: caps idle gaps at IDLE_CAP_MS, accrues short gaps', () => {
  const a = new ActivityTracker();
  a.observe('2026-06-10T10:00:00Z');
  a.observe('2026-06-10T10:01:00Z'); // +60s, under cap → full
  a.observe('2026-06-10T10:30:00Z'); // +29m gap → clamped to 5m
  assert.equal(a.activeMs, 60_000 + IDLE_CAP_MS);
  // out-of-order timestamp does not subtract
  a.observe('2026-06-10T10:00:30Z');
  assert.equal(a.activeMs, 60_000 + IDLE_CAP_MS);
});

test('projectKeyFromPath: tilde-collapses the home dir', () => {
  const home = process.env.HOME;
  if (home) assert.equal(projectKeyFromPath(home + '/work/x'), '~/work/x');
  assert.equal(projectKeyFromPath('/etc/thing'), '/etc/thing');
});
