// `codenomics benchmark <join|leave|status>` — opt into the cross-org benchmark.
// Joining = consent + email signup + a 12h auto-sync schedule. Mirrors the
// dashboard /api/benchmark/join flow so the CLI and UI behave identically.

import { parseArgs } from 'node:util';
import { loadConfig, saveUserConfig, mergeConfig } from '../../core/config.js';
import { readIndex } from '../../core/store.js';
import { pushRollups, readSyncState } from '../../core/sync-client.js';
import { checkPersistentInstall, installAutoSync, uninstallAutoSync, autoSyncStatus } from '../../core/scheduler.js';
import { BENCHMARK_CONSENT_TEXT, recordBenchmarkConsent, benchmarkConsent } from '../../core/consent.js';
import { clientHeaders } from '../../core/version.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function run(argv: string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case 'join':
      return join(argv.slice(1));
    case 'leave':
      return leave();
    case 'status':
      return status();
    default:
      console.log(
        [
          'usage: codenomics benchmark <join|leave|status>',
          '',
          'Subcommands:',
          '  join    opt in: record consent, sign up for an org token, enable 12h auto-sync',
          '  leave   opt out: disconnect org token, remove auto-sync schedule',
          '  status  show membership state, auto-sync schedule, and last sync result',
          '',
          'Options for `join`:',
          '  --email <addr>   email address to associate with the benchmark org (required for new sign-up)',
          '  --force          install the auto-sync schedule even when running from an npx cache path',
        ].join('\n'),
      );
      return sub ? 1 : 0;
  }
}

async function join(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      force: { type: 'boolean', default: false }, // schedule despite an npx-cache bin path
    },
  });

  console.log('\n' + BENCHMARK_CONSENT_TEXT + '\n');

  const { config } = loadConfig({ flags: {} });
  const endpoint = (config.sync.endpoint ?? '').replace(/\/+$/, '');
  if (!endpoint) {
    console.error('no sync endpoint configured (sync.endpoint)');
    return 1;
  }

  // Idempotent: if already joined, reuse the existing org token (re-running just
  // (re)installs the auto-sync schedule). Only sign up — minting a NEW org — when
  // there is no token yet. This prevents accidental duplicate orgs on re-join.
  let token = config.sync.token ?? '';
  if (token) {
    console.log('• already joined — reusing your org; re-enabling auto-sync.');
  } else {
    const email = (values.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      console.error('a valid email is required:  codenomics benchmark join --email you@company.com');
      return 1;
    }
    try {
      const r = await fetch(`${endpoint}/v1/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...clientHeaders() },
        body: JSON.stringify({ email }),
      });
      if (r.status === 426) {
        const latest = r.headers.get('x-codenomics-latest');
        console.error(`this codenomics CLI is too old to join the benchmark${latest ? ` (latest ${latest})` : ''}. Upgrade: npm i -g codenomics@latest`);
        return 1;
      }
      if (!r.ok) {
        console.error(`signup failed (HTTP ${r.status})`);
        return 1;
      }
      const body = (await r.json()) as { token?: string };
      if (!body.token) {
        console.error('signup returned no token');
        return 1;
      }
      token = body.token;
    } catch (e) {
      console.error(`signup failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    saveUserConfig(mergeConfig(config, { sync: { token } }));
    recordBenchmarkConsent(email);
    console.log('✓ joined the benchmark — email recorded, token saved.');
  }

  // schedule auto-sync (refuse from an ephemeral npx cache unless --force)
  const check = checkPersistentInstall();
  if (!check.ok && !values.force) {
    console.log('');
    console.log(`⚠ auto-sync NOT scheduled — ${check.reason}.`);
    console.log('  A scheduled job needs a persistent install. Install globally, then re-join:');
    console.log('    npm i -g codenomics && codenomics benchmark join');
    console.log('  (you are joined; until then, contribute manually with: codenomics sync --push)');
  } else {
    const res = installAutoSync();
    if (res.ok) console.log(`✓ auto-sync scheduled — ${res.mechanism}, every 12h.`);
    else console.log(`⚠ could not schedule auto-sync: ${res.error}. Sync manually: codenomics sync --push`);
  }

  // immediate first contribution so data lands now, not in 12h
  const index = readIndex();
  if (index.sessions.length) {
    const push = await pushRollups({ endpoint, token, salt: config.sync.salt ?? '', sessions: index.sessions });
    if (push.ok) console.log(`✓ first sync — ${push.accepted} aggregate rows uploaded.`);
    else console.log(`first sync deferred: ${push.error}`);
  } else {
    console.log('run `codenomics index` then `codenomics sync --push` for your first contribution.');
  }
  return 0;
}

function leave(): number {
  const { config } = loadConfig();
  saveUserConfig(mergeConfig(config, { sync: { token: null } }));
  const u = uninstallAutoSync();
  console.log('✓ left the benchmark — token disconnected.');
  console.log(u.ok ? '✓ auto-sync schedule removed.' : `⚠ could not remove schedule: ${u.detail}`);
  return 0;
}

function status(): number {
  const { config } = loadConfig();
  const joined = Boolean(config.sync.token);
  const consent = benchmarkConsent();
  const sched = autoSyncStatus();
  const state = readSyncState();
  console.log(`benchmark:  ${joined ? 'joined' : 'not joined'}`);
  if (consent) console.log(`consent:    v${consent.version} · ${consent.email} · ${consent.acceptedAt}`);
  console.log(`endpoint:   ${config.sync.endpoint ?? '(none)'}`);
  console.log(`auto-sync:  ${sched.installed ? `${sched.mechanism} · ${sched.schedule}` : 'not scheduled'}`);
  console.log(`last sync:  ${state.lastSyncedAt ? `${state.lastSyncedAt} · ${state.acceptedRows} rows` : 'never'}`);
  if (state.lastError) console.log(`last error: ${state.lastError}`);
  return 0;
}
