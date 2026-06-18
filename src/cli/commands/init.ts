import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEFAULT_CONFIG, saveUserConfig, userConfigPath, type CodenomicsConfig } from '../../core/config.js';
import { ensureDataDir, readSummaries, summariesPath, writeSummaries } from '../../core/store.js';
import { allCollectors } from '../../collectors/registry.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log('usage: npx codenomics init [--from <old claude-stats data dir>] [--force]');
    return 0;
  }

  ensureDataDir();

  // vendor autodetect: enable collectors whose default roots exist
  const cfg: CodenomicsConfig = structuredClone(DEFAULT_CONFIG);
  const found: string[] = [];
  for (const c of allCollectors()) {
    const present = c.defaultRoots().some((r) => fs.existsSync(r));
    cfg.collectors[c.vendor] = { enabled: present };
    if (present) found.push(c.vendor);
  }

  // Privacy hardening (PRIVACY.md #5): every config carries a per-install random
  // salt so synced project-key hashes are not deterministic / dictionary-recoverable.
  cfg.sync.salt = randomBytes(16).toString('hex');

  if (fs.existsSync(userConfigPath()) && !values.force) {
    // Don't clobber an existing config — but backfill a salt if it predates this
    // (early adopters synced with an empty salt; this upgrades them in place).
    const added = ensureSalt(userConfigPath());
    console.log(
      added
        ? `config already exists: ${userConfigPath()} — added a sync salt (privacy hardening)`
        : `config already exists: ${userConfigPath()} (use --force to overwrite)`,
    );
  } else {
    saveUserConfig(cfg);
    console.log(`wrote ${userConfigPath()}`);
  }
  console.log(found.length ? `detected agents: ${found.join(', ')}` : 'no agent logs detected yet — collectors stay disabled until logs appear');

  if (values.from) {
    const src = path.join(values.from, 'summaries.json');
    if (fs.existsSync(src)) {
      const old = JSON.parse(fs.readFileSync(src, 'utf8')) as Record<string, { text: string; at: number }>;
      const merged = readSummaries();
      let imported = 0;
      for (const [sessionId, entry] of Object.entries(old)) {
        const key = `claude-code:${sessionId}`;
        if (!merged[key]) {
          merged[key] = entry;
          imported++;
        }
      }
      writeSummaries(merged);
      console.log(`imported ${imported} session recaps -> ${summariesPath()}`);
    } else {
      console.error(`no summaries.json found in ${values.from}`);
    }
  }

  console.log('\nnext steps:');
  console.log('  npx codenomics index        # scan agent logs');
  console.log('  npx codenomics serve --open # local dashboard');
  console.log('  npx codenomics report weekly');
  return 0;
}

/** Backfill a random sync salt into an existing on-disk config if it lacks one,
 *  touching no other field. Returns true if a salt was added. */
function ensureSalt(configPath: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { sync?: { salt?: string | null } };
    if (raw.sync && typeof raw.sync.salt === 'string' && raw.sync.salt.length > 0) return false;
    raw.sync = { ...(raw.sync ?? {}), salt: randomBytes(16).toString('hex') };
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    return true;
  } catch {
    return false;
  }
}
