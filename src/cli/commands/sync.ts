import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readIndex } from '../../core/store.js';
import { buildRollups } from '../../core/rollup.js';
import { loadConfig } from '../../core/config.js';
import { SCHEMA_VERSION, type RollupV1 } from '../../core/schema.js';

// Rows per request. The backend caps a single body well above this; chunking
// keeps payloads small and lets a partial failure retry cheaply.
const CHUNK = 5000;

/** Hash a project key so the one potentially identifying string never leaves the
 *  machine in the clear (privacy commitment #5). The backend requires project to
 *  be a hex hash, so this also makes the payload acceptable to /v1/sync. */
function hashProject(project: string, salt: string): string {
  return createHash('sha256').update(salt).update('\0').update(project).digest('hex');
}

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
    console.log('usage: npx codenomics sync [--push] [--endpoint URL] [--token TOK] [--json]');
    console.log('  (no flags) preview the exact aggregate payload that --push would send');
    return 0;
  }

  const index = readIndex();
  if (!index.sessions.length) {
    console.error('index is empty — run `npx codenomics index` first');
    return 1;
  }
  const rollups = buildRollups(index.sessions);

  if (!values.push) {
    return preview(rollups, values.json);
  }

  // --- push path ---
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

  // Hash project keys in place before anything leaves the machine.
  const salt = config.sync.salt ?? '';
  const payloadRows: RollupV1[] = rollups.map((r) => ({ ...r, project: hashProject(r.project, salt) }));

  const url = `${endpoint}/v1/sync`;
  let accepted = 0;
  for (let i = 0; i < payloadRows.length; i += CHUNK) {
    const chunk = payloadRows.slice(i, i + CHUNK);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, rollups: chunk }),
      });
    } catch (e) {
      console.error(`sync failed: ${(e as Error).message}`);
      return 1;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`sync rejected (HTTP ${res.status}): ${detail.slice(0, 300)}`);
      return 1;
    }
    const body = (await res.json().catch(() => ({}))) as { accepted?: number };
    accepted += body.accepted ?? chunk.length;
  }

  console.log(`synced ${accepted} aggregate rows to ${endpoint} (aggregates only; see PRIVACY.md).`);
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
