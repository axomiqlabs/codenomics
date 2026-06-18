import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isNewer, cliVersion, clientHeaders, VERSION_HEADER } from '../dist/core/version.js';

test('parseVersion: core triples, prerelease/build stripped, junk rejected', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v0.2.6'), [0, 2, 6]);
  assert.deepEqual(parseVersion('1.2.3-rc.1'), [1, 2, 3]);
  assert.deepEqual(parseVersion('1.2.3+build5'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('1.2.x'), null);
  assert.equal(parseVersion('garbage'), null);
});

test('isNewer: strict major/minor/patch ordering', () => {
  assert.equal(isNewer('0.3.0', '0.2.6'), true);
  assert.equal(isNewer('0.2.7', '0.2.6'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.2.6', '0.2.6'), false);
  assert.equal(isNewer('0.2.5', '0.2.6'), false);
  // unparseable inputs can never trigger a spurious "newer"
  assert.equal(isNewer('latest', '0.2.6'), false);
  assert.equal(isNewer('0.2.7', 'unknown'), false);
});

test('cliVersion: reads the bundled package.json (real semver)', () => {
  assert.match(cliVersion(), /^\d+\.\d+\.\d+/);
});

test('clientHeaders: version header + user-agent carry the version, no PII', () => {
  const h = clientHeaders();
  assert.equal(h[VERSION_HEADER], cliVersion());
  assert.equal(h['user-agent'], `codenomics/${cliVersion()}`);
});
