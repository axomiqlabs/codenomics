import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate, recordLatest, updateNotice, shouldNotify } from '../dist/core/update-check.js';

/** Isolate each test's cache in its own temp data dir (dataDir() reads this env). */
function withDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-upd-'));
  process.env.CODENOMICS_DATA_DIR = dir;
  return dir;
}

function jsonFetch(version) {
  return async () => new Response(JSON.stringify({ version }), { status: 200 });
}

const DAY = 24 * 60 * 60 * 1000;

test('checkForUpdate: empty cache → polls registry, reports + caches latest', async () => {
  const dir = withDataDir();
  const r = await checkForUpdate({ current: '0.2.6', now: 1000, fetchImpl: jsonFetch('0.9.0') });
  assert.equal(r.latest, '0.9.0');
  assert.equal(r.updateAvailable, true);
  const cache = JSON.parse(fs.readFileSync(path.join(dir, '.update-check.json'), 'utf8'));
  assert.equal(cache.latest, '0.9.0');
  assert.equal(cache.checkedAt, 1000);
});

test('checkForUpdate: fresh cache (<24h) is used without any network call', async () => {
  withDataDir();
  await checkForUpdate({ current: '0.2.6', now: 1000, fetchImpl: jsonFetch('0.9.0') });
  let called = false;
  const r = await checkForUpdate({
    current: '0.2.6',
    now: 1000 + DAY / 2,
    fetchImpl: async () => { called = true; throw new Error('should not fetch'); },
  });
  assert.equal(called, false);
  assert.equal(r.latest, '0.9.0');
  assert.equal(r.updateAvailable, true);
});

test('checkForUpdate: stale cache (>24h) re-polls', async () => {
  withDataDir();
  await checkForUpdate({ current: '0.2.6', now: 1000, fetchImpl: jsonFetch('0.9.0') });
  const r = await checkForUpdate({ current: '0.2.6', now: 1000 + DAY + 1, fetchImpl: jsonFetch('1.0.0') });
  assert.equal(r.latest, '1.0.0');
});

test('checkForUpdate: poll fails with no cache → latest null, no false nudge', async () => {
  withDataDir();
  const r = await checkForUpdate({
    current: '0.2.6',
    now: 1000,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(r.latest, null);
  assert.equal(r.updateAvailable, false);
});

test('checkForUpdate: poll fails but cache exists → falls back to last known', async () => {
  withDataDir();
  await checkForUpdate({ current: '0.2.6', now: 1000, fetchImpl: jsonFetch('0.9.0') });
  const r = await checkForUpdate({
    current: '0.2.6',
    now: 1000 + DAY + 1,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(r.latest, '0.9.0'); // stale, but better than nothing
});

test('checkForUpdate: current already latest → no update', async () => {
  withDataDir();
  const r = await checkForUpdate({ current: '0.9.0', now: 1000, fetchImpl: jsonFetch('0.9.0') });
  assert.equal(r.updateAvailable, false);
});

test('recordLatest: an out-of-band hint (e.g. sync response) primes the cache', async () => {
  withDataDir();
  recordLatest('0.9.0', 5000);
  let called = false;
  const r = await checkForUpdate({
    current: '0.2.6',
    now: 5000 + 1,
    fetchImpl: async () => { called = true; throw new Error('should not fetch'); },
  });
  assert.equal(called, false);
  assert.equal(r.latest, '0.9.0');
  assert.equal(r.updateAvailable, true);
});

test('recordLatest: ignores a malformed version', async () => {
  const dir = withDataDir();
  recordLatest('not-a-version', 5000);
  assert.equal(fs.existsSync(path.join(dir, '.update-check.json')), false);
});

test('updateNotice: shows both versions and the upgrade command', () => {
  const n = updateNotice('0.2.6', '0.9.0');
  assert.match(n, /0\.2\.6/);
  assert.match(n, /0\.9\.0/);
  assert.match(n, /npm i -g codenomics@latest/);
});

test('shouldNotify: opt-out env vars suppress the check', () => {
  for (const key of ['CODENOMICS_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER', 'CI']) {
    const prev = process.env[key];
    process.env[key] = '1';
    assert.equal(shouldNotify('report', []), false);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});
