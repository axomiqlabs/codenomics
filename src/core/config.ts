// Config loading + precedence: flags > CODENOMICS_* env > project .codenomics.json
// > user ~/.config/codenomics/config.json > built-in defaults.
// Resolved once here; no other module reads config files directly.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LimitMetric = 'costUsd' | 'trueUsd' | 'tokensIn' | 'tokensOut' | 'tokensTotal';
export type LimitPeriod = 'day' | 'week' | 'month';

export interface LimitConfig {
  id: string;
  metric: LimitMetric;
  period: LimitPeriod;
  max: number;
  /** 'global' | 'project:<key>' | 'vendor:<vendor>' */
  scope: string;
}

export interface PricingOverride {
  in: number;
  out: number;
  /** multipliers default to vendor norms when omitted; absolute $/MTok here */
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface DriverConfig {
  /** $ of human attention consumed per interactive prompt (machine sessions: $0) */
  attentionUsdPerPrompt: number;
  /** optional loaded eng cost; adds activeHours x rate to true cost when > 0 */
  engHourlyRateUsd: number;
}

export interface SyncConfig {
  /** base URL of the cloud benchmark backend (no path), or null to disable */
  endpoint: string | null;
  /** bearer token; prefer CODENOMICS_SYNC_TOKEN env over storing it on disk */
  token: string | null;
  /** optional salt mixed into project-key hashes before upload (privacy #5) */
  salt: string | null;
}

export interface CodenomicsConfig {
  configVersion: 1;
  drivers: DriverConfig;
  pricing: Record<string, PricingOverride>;
  limits: LimitConfig[];
  collectors: Record<string, { enabled: boolean; root?: string }>;
  report: { slackWebhookUrl: string | null };
  server: { port: number; host: string };
  sync: SyncConfig;
}

export const DEFAULT_CONFIG: CodenomicsConfig = {
  configVersion: 1,
  drivers: { attentionUsdPerPrompt: 5, engHourlyRateUsd: 0 },
  pricing: {},
  limits: [],
  collectors: {
    'claude-code': { enabled: true },
    codex: { enabled: true },
    gemini: { enabled: true },
  },
  report: { slackWebhookUrl: null },
  server: { port: 3737, host: '127.0.0.1' },
  sync: { endpoint: null, token: null, salt: null },
};

export function configDir(): string {
  if (process.env.CODENOMICS_CONFIG_DIR) return process.env.CODENOMICS_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'codenomics');
}

export function dataDir(): string {
  if (process.env.CODENOMICS_DATA_DIR) return process.env.CODENOMICS_DATA_DIR;
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'codenomics');
}

export function userConfigPath(): string {
  return path.join(configDir(), 'config.json');
}

export function projectConfigPath(cwd: string): string | null {
  // walk up from cwd to filesystem root looking for .codenomics.json
  let dir = path.resolve(cwd);
  for (;;) {
    const p = path.join(dir, '.codenomics.json');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJsonFile(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys that must never be assigned from untrusted input (prototype pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Deep merge: source values win; arrays and scalars replace wholesale. */
export function mergeConfig<T>(base: T, source: unknown): T {
  if (!isPlainObject(source)) return base;
  if (!isPlainObject(base)) return source as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || UNSAFE_KEYS.has(k)) continue; // drop __proto__/constructor/prototype
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeConfig(out[k], v) : v;
  }
  return out as T;
}

function envOverrides(): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (process.env.CODENOMICS_PORT) {
    const port = Number(process.env.CODENOMICS_PORT);
    if (Number.isFinite(port)) o.server = { port };
  }
  if (process.env.CODENOMICS_SLACK_WEBHOOK_URL) {
    o.report = { slackWebhookUrl: process.env.CODENOMICS_SLACK_WEBHOOK_URL };
  }
  if (process.env.CODENOMICS_ATTENTION_USD) {
    const v = Number(process.env.CODENOMICS_ATTENTION_USD);
    if (Number.isFinite(v)) o.drivers = { attentionUsdPerPrompt: v };
  }
  const sync: Record<string, unknown> = {};
  if (process.env.CODENOMICS_SYNC_ENDPOINT) sync.endpoint = process.env.CODENOMICS_SYNC_ENDPOINT;
  if (process.env.CODENOMICS_SYNC_TOKEN) sync.token = process.env.CODENOMICS_SYNC_TOKEN;
  if (Object.keys(sync).length) o.sync = sync;
  return o;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** highest-precedence partial, from CLI flags */
  flags?: Record<string, unknown>;
}

export interface LoadedConfig {
  config: CodenomicsConfig;
  userPath: string;
  projectPath: string | null;
  problems: string[];
}

export function validateConfig(cfg: CodenomicsConfig): string[] {
  const problems: string[] = [];
  if (cfg.drivers.attentionUsdPerPrompt < 0) problems.push('drivers.attentionUsdPerPrompt must be >= 0');
  if (cfg.drivers.engHourlyRateUsd < 0) problems.push('drivers.engHourlyRateUsd must be >= 0');
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
    problems.push(`server.port invalid: ${cfg.server.port}`);
  }
  const seen = new Set<string>();
  for (const lim of cfg.limits) {
    if (!lim.id) problems.push('limit missing id');
    else if (seen.has(lim.id)) problems.push(`duplicate limit id: ${lim.id}`);
    seen.add(lim.id);
    if (!['costUsd', 'trueUsd', 'tokensIn', 'tokensOut', 'tokensTotal'].includes(lim.metric)) {
      problems.push(`limit ${lim.id}: unknown metric ${lim.metric}`);
    }
    if (!['day', 'week', 'month'].includes(lim.period)) problems.push(`limit ${lim.id}: unknown period ${lim.period}`);
    if (!(lim.max > 0)) problems.push(`limit ${lim.id}: max must be > 0`);
    if (lim.scope !== 'global' && !/^(project|vendor):.+$/.test(lim.scope)) {
      problems.push(`limit ${lim.id}: scope must be global, project:<key>, or vendor:<vendor>`);
    }
  }
  for (const [model, p] of Object.entries(cfg.pricing)) {
    if (!(p.in >= 0) || !(p.out >= 0)) problems.push(`pricing ${model}: in/out must be >= 0`);
  }
  return problems;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const userPath = userConfigPath();
  const projPath = projectConfigPath(cwd);

  let cfg = DEFAULT_CONFIG;
  cfg = mergeConfig(cfg, readJsonFile(userPath));
  if (projPath) cfg = mergeConfig(cfg, readJsonFile(projPath));
  cfg = mergeConfig(cfg, envOverrides());
  cfg = mergeConfig(cfg, opts.flags);

  return { config: cfg, userPath, projectPath: projPath, problems: validateConfig(cfg) };
}

export function saveUserConfig(cfg: CodenomicsConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(userConfigPath(), JSON.stringify(cfg, null, 2) + '\n');
}

/** Dotted-path get/set used by `codenomics config`. */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  if (parts.some((p) => UNSAFE_KEYS.has(p))) {
    throw new Error(`refusing to set unsafe path: ${dotted}`);
  }
  let cur: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}
