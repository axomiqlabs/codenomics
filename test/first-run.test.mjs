import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../dist/cli/main.js', import.meta.url).pathname;

// Run the built CLI with a throwaway data dir and non-TTY stdin (input: '' makes
// stdin a pipe, not a tty). A 20s timeout turns a hang into a failure.
function runCli(args, env = {}) {
  return spawnSync('node', [CLI, ...args], {
    input: '',
    timeout: 20_000,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-fr-'));
}

test('first-run: non-interactive discloses, auto-accepts, and does not hang', () => {
  const dir = tmpDataDir();
  try {
    const r = runCli(['doctor'], { CODENOMICS_DATA_DIR: dir });
    assert.equal(r.signal, null, 'must not be killed by timeout (no hang)');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Codenomics — first run/);
    assert.match(r.stdout, /never leave this machine/);
    // acknowledgement is persisted so it shows once
    const ack = JSON.parse(fs.readFileSync(path.join(dir, '.disclosure-ack.json'), 'utf8'));
    assert.equal(ack.version, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first-run: a second run does not re-disclose', () => {
  const dir = tmpDataDir();
  try {
    runCli(['doctor'], { CODENOMICS_DATA_DIR: dir });
    const second = runCli(['doctor'], { CODENOMICS_DATA_DIR: dir });
    assert.equal(second.status, 0);
    assert.doesNotMatch(second.stdout, /first run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first-run: CODENOMICS_ACCEPT_DISCLOSURE=1 skips the notice', () => {
  const dir = tmpDataDir();
  try {
    const r = runCli(['doctor'], { CODENOMICS_DATA_DIR: dir, CODENOMICS_ACCEPT_DISCLOSURE: '1' });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /first run/);
    // still records the acknowledgement
    assert.ok(fs.existsSync(path.join(dir, '.disclosure-ack.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
