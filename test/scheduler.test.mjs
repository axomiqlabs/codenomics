import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPersistentInstall,
  buildWrapperScript,
  buildSystemdUnits,
  buildCronLine,
  buildLaunchdPlist,
  buildSchtasksXml,
  INTERVAL_SEC,
} from '../dist/core/scheduler.js';

const PATHS = { node: '/usr/bin/node', bin: '/usr/local/lib/node_modules/codenomics/dist/cli/main.js' };

test('npx guard: rejects an ephemeral npx cache path', () => {
  assert.equal(checkPersistentInstall('/home/u/.npm/_npx/abc123/node_modules/codenomics/dist/cli/main.js').ok, false);
  assert.equal(checkPersistentInstall('/Users/u/.npm/_npx/deadbeef/node_modules/.bin/codenomics').ok, false);
});

test('npx guard: accepts a persistent global path; rejects empty', () => {
  assert.equal(checkPersistentInstall(PATHS.bin).ok, true);
  assert.equal(checkPersistentInstall('').ok, false);
});

test('wrapper script: unix has shebang + index + sync --push with absolute paths', () => {
  const s = buildWrapperScript(PATHS, 'linux');
  assert.match(s, /^#!\/bin\/sh/);
  assert.ok(s.includes(`"${PATHS.node}" "${PATHS.bin}" index`));
  assert.ok(s.includes('sync --push'));
});

test('wrapper script: windows is a .cmd with @echo off', () => {
  const s = buildWrapperScript(PATHS, 'win32');
  assert.match(s, /^@echo off/);
  assert.ok(s.includes('sync --push'));
});

test('systemd units: 12h interval, catch-up, ExecStart points at the wrapper', () => {
  const { service, timer } = buildSystemdUnits('/home/u/.config/codenomics/autosync.sh');
  assert.ok(timer.includes('OnUnitActiveSec=12h'));
  assert.ok(timer.includes('Persistent=true'));
  assert.ok(service.includes('ExecStart=/home/u/.config/codenomics/autosync.sh'));
});

test('cron line: every 12h, runs the wrapper', () => {
  assert.equal(buildCronLine('/w/autosync.sh'), '0 */12 * * * /w/autosync.sh');
});

test('launchd plist: StartInterval=43200, RunAtLoad, references the wrapper', () => {
  const plist = buildLaunchdPlist('/w/autosync.sh');
  assert.ok(plist.includes(`<integer>${INTERVAL_SEC}</integer>`));
  assert.equal(INTERVAL_SEC, 43200);
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
  assert.ok(plist.includes('/w/autosync.sh'));
});

test('schtasks XML: 12h repetition + StartWhenAvailable + wrapper command', () => {
  const xml = buildSchtasksXml('C:/w/autosync.cmd');
  assert.ok(xml.includes('<Interval>PT12H</Interval>'));
  assert.ok(xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
  assert.ok(xml.includes('<Command>C:/w/autosync.cmd</Command>'));
});
