import { parseArgs } from 'node:util';
import { readIndex } from '../../core/store.js';
import { buildRollups } from '../../core/rollup.js';
import { loadConfig } from '../../core/config.js';
import { pushRollups } from '../../core/sync-client.js';
import type { RollupV1 } from '../../core/schema.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      endpoint: { type: 'string' },
      token: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      [
        'usage: npx codenomics sync [--push] [--endpoint URL] [--token TOK] [--json]',
        '',
        'Without --push, prints a human-readable preview of the aggregate payload that would be sent.',
        '',
        'Options:',
        '  --push              upload the aggregate payload to the sync endpoint',
        '  --endpoint <URL>    override the sync endpoint (default: config sync.endpoint)',
        '  --token <TOK>       override the sync token (default: config sync.token or CODENOMICS_SYNC_TOKEN env)',
        '  --json              in preview mode, print the raw payload as JSON instead of a summary',
      ].join('\n'),
    );
    return 0;
  }

  const index = readIndex();
  if (!index.sessions.length) {
    console.error('index is empty — run `npx codenomics index` first');
    return 1;
  }

  if (!values.push) {
    return preview(buildRollups(index.sessions), values.json);
  }

  // --- push path (delegates to the shared sync client) ---
  const { config } = loadConfig({ flags: {} });
  const endpoint = (values.endpoint ?? config.sync.endpoint ?? '').replace(/\/+$/, '');
  const token = values.token ?? config.sync.token ?? process.env.CODENOMICS_SYNC_TOKEN ?? '';
  if (!endpoint) {
    console.error('no sync endpoint — set sync.endpoint (or --endpoint / CODENOMICS_SYNC_ENDPOINT)');
    return 1;
  }
  if (!token) {
    console.error('no sync token — set CODENOMICS_SYNC_TOKEN (or sync.token / --token)');
    return 1;
  }

  const salt = config.sync.salt ?? '';
  if (!salt) {
    console.error('warning: no project-key salt configured — hashes are deterministic and dictionary-recoverable. run `npx codenomics init` to add one (see PRIVACY.md).');
  }
  const result = await pushRollups({ endpoint, token, salt, sessions: index.sessions });
  if (!result.ok) {
    console.error(result.error ?? 'sync failed');
    return 1;
  }
  console.log(`synced ${result.accepted} aggregate rows to ${endpoint} (aggregates only; see PRIVACY.md).`);
  return 0;
}

function preview(rollups: RollupV1[], asJson: boolean): number {
  if (asJson) {
    console.log(JSON.stringify(rollups, null, 2));
    return 0;
  }
  const days = new Set(rollups.map((r) => r.day));
  const vendors = new Set(rollups.map((r) => r.vendor));
  console.log('npx codenomics sync — PREVIEW (re-run with --push to upload)');
  console.log('');
  console.log(`would send ${rollups.length} aggregate rows covering ${days.size} days, ${vendors.size} vendors.`);
  console.log('');
  console.log('what each row contains: day, vendor, model, project key (HASHED before');
  console.log('upload), human/machine, token counts, session/prompt/commit counts, active time.');
  console.log('what NEVER leaves this machine: prompts, code, transcripts, tool output,');
  console.log('file-level paths — the sync payload is aggregates only (see PRIVACY.md).');
  console.log('');
  console.log('sample row:');
  console.log(JSON.stringify(rollups[rollups.length - 1], null, 2));
  console.log('');
  console.log('inspect the full payload with: npx codenomics sync --json');
  return 0;
}
