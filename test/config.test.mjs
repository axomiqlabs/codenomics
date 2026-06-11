import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, mergeConfig, DEFAULT_CONFIG, getPath, setPath, validateConfig } from '../dist/core/config.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-cfg-'));
}

test('config precedence: flags > env > project > user > defaults', () => {
  const cfgDir = tmpdir();
  const projDir = tmpdir();
  process.env.CODENOMICS_CONFIG_DIR = cfgDir;
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ drivers: { attentionUsdPerPrompt: 1 }, server: { port: 1111 } }));
  fs.writeFileSync(path.join(projDir, '.codenomics.json'), JSON.stringify({ drivers: { attentionUsdPerPrompt: 2 } }));

  // project beats user
  let { config } = loadConfig({ cwd: projDir });
  assert.equal(config.drivers.attentionUsdPerPrompt, 2);
  assert.equal(config.server.port, 1111); // user survives where project is silent
  assert.equal(config.drivers.engHourlyRateUsd, 0); // defaults survive everywhere

  // env beats project
  process.env.CODENOMICS_ATTENTION_USD = '3';
  ({ config } = loadConfig({ cwd: projDir }));
  assert.equal(config.drivers.attentionUsdPerPrompt, 3);

  // flags beat env
  ({ config } = loadConfig({ cwd: projDir, flags: { drivers: { attentionUsdPerPrompt: 4 } } }));
  assert.equal(config.drivers.attentionUsdPerPrompt, 4);

  delete process.env.CODENOMICS_ATTENTION_USD;
  delete process.env.CODENOMICS_CONFIG_DIR;
});

test('config: project file found by walking up from cwd', () => {
  const root = tmpdir();
  const nested = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(root, '.codenomics.json'), JSON.stringify({ server: { port: 2222 } }));
  process.env.CODENOMICS_CONFIG_DIR = tmpdir(); // empty user config
  const { config, projectPath } = loadConfig({ cwd: nested });
  assert.equal(config.server.port, 2222);
  assert.equal(projectPath, path.join(root, '.codenomics.json'));
  delete process.env.CODENOMICS_CONFIG_DIR;
});

test('mergeConfig: arrays replace wholesale, objects merge deep', () => {
  const merged = mergeConfig(
    { limits: [{ id: 'a' }], drivers: { x: 1, y: 2 } },
    { limits: [{ id: 'b' }], drivers: { y: 3 } },
  );
  assert.deepEqual(merged.limits, [{ id: 'b' }]);
  assert.deepEqual(merged.drivers, { x: 1, y: 3 });
});

test('getPath/setPath dotted access', () => {
  const obj = { a: { b: { c: 1 } } };
  assert.equal(getPath(obj, 'a.b.c'), 1);
  setPath(obj, 'a.b.d', 5);
  assert.equal(obj.a.b.d, 5);
  setPath(obj, 'a.b.c', undefined);
  assert.equal(getPath(obj, 'a.b.c'), undefined);
});

test('validateConfig catches bad limits and drivers', () => {
  const bad = {
    ...DEFAULT_CONFIG,
    drivers: { attentionUsdPerPrompt: -1, engHourlyRateUsd: 0 },
    limits: [
      { id: 'x', metric: 'nope', period: 'day', max: 0, scope: 'global' },
      { id: 'x', metric: 'costUsd', period: 'day', max: 10, scope: 'bogus' },
    ],
  };
  const problems = validateConfig(bad);
  assert.ok(problems.some((p) => p.includes('attentionUsdPerPrompt')));
  assert.ok(problems.some((p) => p.includes('unknown metric')));
  assert.ok(problems.some((p) => p.includes('duplicate limit id')));
  assert.ok(problems.some((p) => p.includes('max must be > 0')));
  assert.ok(problems.some((p) => p.includes('scope must be')));
  assert.equal(validateConfig(DEFAULT_CONFIG).length, 0);
});
