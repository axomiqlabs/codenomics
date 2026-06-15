import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../dist/server/server.js';

function freshEnv() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-srv-'));
  process.env.CODENOMICS_DATA_DIR = data;
  process.env.CODENOMICS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-srvcfg-'));
}

function listen(opts) {
  return new Promise((resolve) => {
    const server = startServer(opts);
    server.on('listening', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('server: rejects cross-origin PUT/POST (CSRF guard)', async () => {
  freshEnv();
  const { server, port } = await listen({ host: '127.0.0.1', port: 0 });
  try {
    // a drive-by page (evil.com origin) must be refused on state-changing requests
    const bad = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
      body: JSON.stringify({ drivers: { attentionUsdPerPrompt: 1 } }),
    });
    assert.equal(bad.status, 403);

    // same-origin (loopback) edit is allowed
    const ok = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ drivers: { attentionUsdPerPrompt: 7, engHourlyRateUsd: 0 } }),
    });
    assert.equal(ok.status, 200);

    // GET data needs no token on a loopback bind
    const data = await fetch(`http://127.0.0.1:${port}/api/data`);
    assert.equal(data.status, 200);
  } finally {
    server.close();
  }
});

test('server: non-loopback bind requires a token on /api', async () => {
  freshEnv();
  // bind to all interfaces; reach it via loopback. token is required.
  const { server, port } = await listen({ host: '0.0.0.0', port: 0 });
  try {
    const noTok = await fetch(`http://127.0.0.1:${port}/api/data`);
    assert.equal(noTok.status, 401);
    const badTok = await fetch(`http://127.0.0.1:${port}/api/data?token=deadbeef`);
    assert.equal(badTok.status, 401);
  } finally {
    server.close();
  }
});
