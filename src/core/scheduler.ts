// Cross-platform installer for the auto-sync job (every 12h: `index && sync --push`).
// Split into a PURE artifact layer (string builders — unit-tested) and a thin
// EFFECT layer (write files + shell out to the OS scheduler). Zero runtime deps.
//
// Design: every OS scheduler just runs ONE wrapper script we generate, so the
// `&&` and path quoting are handled in exactly one place and the per-OS artifact
// stays trivial. launchd/cron/Task-Scheduler run with a minimal PATH, hence the
// absolute node + bin paths baked into the wrapper.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from './config.js';

export const TASK_NAME = 'codenomics-autosync';
export const LAUNCHD_LABEL = 'ai.codenomics.autosync';
export const INTERVAL_SEC = 12 * 60 * 60; // 43200

export type Platform = 'darwin' | 'linux' | 'win32' | 'unsupported';

export function currentPlatform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'win32';
  return 'unsupported';
}

// --- bin resolution + npx guard ---------------------------------------------

export interface JobPaths {
  node: string;
  bin: string;
}

export function resolveJobPaths(): JobPaths {
  return { node: process.execPath, bin: process.argv[1] ?? 'codenomics' };
}

export interface NpxCheck {
  ok: boolean;
  binPath: string;
  reason?: string;
}

/** Auto-sync needs a PERSISTENT install. A scheduled job that points at an npx
 *  cache path silently breaks when npm prunes the cache, so refuse to schedule
 *  from there and tell the user to `npm i -g codenomics`. */
export function checkPersistentInstall(binPath = process.argv[1] ?? ''): NpxCheck {
  if (!binPath) return { ok: false, binPath, reason: 'could not resolve the codenomics binary path' };
  const p = binPath.replace(/\\/g, '/');
  if (p.includes('/_npx/') || p.includes('/.npm/_npx/')) {
    return { ok: false, binPath, reason: 'running from an ephemeral npx cache' };
  }
  return { ok: true, binPath };
}

// --- pure artifact builders (unit-tested) -----------------------------------

export function wrapperPath(platform: Platform = currentPlatform()): string {
  return path.join(configDir(), platform === 'win32' ? 'autosync.cmd' : 'autosync.sh');
}

/** The wrapper script every scheduler invokes. Absolute node + bin paths. */
export function buildWrapperScript(p: JobPaths, platform: Platform = currentPlatform()): string {
  if (platform === 'win32') {
    return ['@echo off', `"${p.node}" "${p.bin}" index && "${p.node}" "${p.bin}" sync --push`, ''].join('\r\n');
  }
  return ['#!/bin/sh', `"${p.node}" "${p.bin}" index && "${p.node}" "${p.bin}" sync --push`, ''].join('\n');
}

export function buildSystemdUnits(wrapper: string): { service: string; timer: string } {
  const service = [
    '[Unit]',
    'Description=Codenomics auto-sync (benchmark aggregates)',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${wrapper}`,
    '',
  ].join('\n');
  const timer = [
    '[Unit]',
    'Description=Codenomics auto-sync every 12h',
    '',
    '[Timer]',
    'OnBootSec=5min',
    'OnUnitActiveSec=12h',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
  return { service, timer };
}

export function buildCronLine(wrapper: string): string {
  // every 12h, on the hour. cron has no catch-up, but at 12h + idempotent sync
  // that's fine: a missed run lands at the next boundary the machine is up.
  return `0 */12 * * * ${wrapper}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildLaunchdPlist(wrapper: string, label = LAUNCHD_LABEL, intervalSec = INTERVAL_SEC): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    `    <string>${escapeXml(wrapper)}</string>`,
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${intervalSec}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Windows Task Scheduler definition: 12h repetition + StartWhenAvailable (catch-up). */
export function buildSchtasksXml(wrapper: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <Triggers>',
    '    <CalendarTrigger>',
    '      <StartBoundary>2026-01-01T00:00:00</StartBoundary>',
    '      <Repetition><Interval>PT12H</Interval></Repetition>',
    '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Settings>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '  </Settings>',
    '  <Actions>',
    `    <Exec><Command>${escapeXml(wrapper)}</Command></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

// --- effect layer -----------------------------------------------------------

export interface InstallResult {
  ok: boolean;
  mechanism: string;
  error?: string;
}

export interface StatusResult {
  installed: boolean;
  mechanism: string | null;
  schedule: string | null;
}

function writeWrapper(): string {
  const platform = currentPlatform();
  const p = resolveJobPaths();
  const file = wrapperPath(platform);
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(file, buildWrapperScript(p, platform));
  if (platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
}

function systemctlUserOk(): boolean {
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
  return r.status === 0;
}

function userSystemdDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

export function installAutoSync(): InstallResult {
  const platform = currentPlatform();
  try {
    const wrapper = writeWrapper();
    if (platform === 'linux') return installLinux(wrapper);
    if (platform === 'darwin') return installDarwin(wrapper);
    if (platform === 'win32') return installWindows(wrapper);
    return { ok: false, mechanism: 'none', error: `unsupported platform: ${process.platform}` };
  } catch (e) {
    return { ok: false, mechanism: 'none', error: e instanceof Error ? e.message : String(e) };
  }
}

function installLinux(wrapper: string): InstallResult {
  if (systemctlUserOk()) {
    const dir = userSystemdDir();
    fs.mkdirSync(dir, { recursive: true });
    const { service, timer } = buildSystemdUnits(wrapper);
    fs.writeFileSync(path.join(dir, `${TASK_NAME}.service`), service);
    fs.writeFileSync(path.join(dir, `${TASK_NAME}.timer`), timer);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
    const r = spawnSync('systemctl', ['--user', 'enable', '--now', `${TASK_NAME}.timer`], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, mechanism: 'systemd', error: r.stderr || 'enable failed' };
    return { ok: true, mechanism: 'systemd --user timer' };
  }
  // cron fallback
  const line = buildCronLine(wrapper);
  const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const existing = cur.status === 0 ? cur.stdout : '';
  if (existing.includes(wrapper)) return { ok: true, mechanism: 'cron' };
  const next = existing.trimEnd() + (existing.trim() ? '\n' : '') + line + '\n';
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, mechanism: 'cron', error: r.stderr || 'crontab install failed' };
  return { ok: true, mechanism: 'cron' };
}

function installDarwin(wrapper: string): InstallResult {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, buildLaunchdPlist(wrapper));
  const uid = process.getuid?.() ?? 0;
  // modern API first, then legacy.
  spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { encoding: 'utf8' });
  let r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
  if (r.status !== 0) r = spawnSync('launchctl', ['load', '-w', plistPath], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, mechanism: 'launchd', error: r.stderr || 'launchctl load failed' };
  return { ok: true, mechanism: 'launchd' };
}

function installWindows(wrapper: string): InstallResult {
  const xmlPath = path.join(os.tmpdir(), `${TASK_NAME}.xml`);
  fs.writeFileSync(xmlPath, buildSchtasksXml(wrapper));
  const r = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'], { encoding: 'utf8' });
  try { fs.unlinkSync(xmlPath); } catch { /* best effort */ }
  if (r.status !== 0) return { ok: false, mechanism: 'schtasks', error: r.stderr || 'schtasks create failed' };
  return { ok: true, mechanism: 'Task Scheduler' };
}

export function uninstallAutoSync(): { ok: boolean; detail?: string } {
  const platform = currentPlatform();
  try {
    if (platform === 'linux') {
      spawnSync('systemctl', ['--user', 'disable', '--now', `${TASK_NAME}.timer`], { encoding: 'utf8' });
      for (const f of [`${TASK_NAME}.service`, `${TASK_NAME}.timer`]) {
        try { fs.unlinkSync(path.join(userSystemdDir(), f)); } catch { /* missing is fine */ }
      }
      spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
      // also strip a cron-fallback line if present
      const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      if (cur.status === 0 && cur.stdout.includes(wrapperPath('linux'))) {
        const next = cur.stdout.split('\n').filter((l) => !l.includes(wrapperPath('linux'))).join('\n');
        spawnSync('crontab', ['-'], { input: next.replace(/\n+$/, '\n'), encoding: 'utf8' });
      }
      return { ok: true };
    }
    if (platform === 'darwin') {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
      const uid = process.getuid?.() ?? 0;
      spawnSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { encoding: 'utf8' });
      spawnSync('launchctl', ['unload', '-w', plistPath], { encoding: 'utf8' });
      try { fs.unlinkSync(plistPath); } catch { /* missing is fine */ }
      return { ok: true };
    }
    if (platform === 'win32') {
      spawnSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { encoding: 'utf8' });
      return { ok: true };
    }
    return { ok: false, detail: 'unsupported platform' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export function autoSyncStatus(): StatusResult {
  const platform = currentPlatform();
  if (platform === 'linux') {
    if (fs.existsSync(path.join(userSystemdDir(), `${TASK_NAME}.timer`))) {
      const r = spawnSync('systemctl', ['--user', 'is-enabled', `${TASK_NAME}.timer`], { encoding: 'utf8' });
      if (r.status === 0) return { installed: true, mechanism: 'systemd --user timer', schedule: 'every 12h' };
    }
    const cur = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
    if (cur.status === 0 && cur.stdout.includes(wrapperPath('linux'))) {
      return { installed: true, mechanism: 'cron', schedule: 'every 12h' };
    }
    return { installed: false, mechanism: null, schedule: null };
  }
  if (platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    return fs.existsSync(plistPath)
      ? { installed: true, mechanism: 'launchd', schedule: 'every 12h' }
      : { installed: false, mechanism: null, schedule: null };
  }
  if (platform === 'win32') {
    const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME], { encoding: 'utf8' });
    return r.status === 0
      ? { installed: true, mechanism: 'Task Scheduler', schedule: 'every 12h' }
      : { installed: false, mechanism: null, schedule: null };
  }
  return { installed: false, mechanism: null, schedule: null };
}
