import { parseArgs } from 'node:util';
import { readIndex } from '../../core/store.js';
import { buildRollups } from '../../core/rollup.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log('usage: codenomics sync [--json]   (preview only — cloud sync is not yet available)');
    return 0;
  }

  const index = readIndex();
  if (!index.sessions.length) {
    console.error('index is empty — run `codenomics index` first');
    return 1;
  }
  const rollups = buildRollups(index.sessions);

  if (values.json) {
    console.log(JSON.stringify(rollups, null, 2));
    return 0;
  }

  const days = new Set(rollups.map((r) => r.day));
  const vendors = new Set(rollups.map((r) => r.vendor));
  console.log('codenomics sync — PREVIEW (cloud sync is not yet available)');
  console.log('');
  console.log(`would send ${rollups.length} aggregate rows covering ${days.size} days, ${vendors.size} vendors.`);
  console.log('');
  console.log('what each row contains: day, vendor, model, project key (cwd-derived —');
  console.log('future sync will offer aliasing/hashing), human/machine, token counts,');
  console.log('session/prompt/commit counts, active time.');
  console.log('what NEVER leaves this machine: prompts, code, transcripts, tool output,');
  console.log('file-level paths — the sync payload is aggregates only (see PRIVACY.md).');
  console.log('');
  console.log('sample row:');
  console.log(JSON.stringify(rollups[rollups.length - 1], null, 2));
  console.log('');
  console.log('inspect the full payload with: codenomics sync --json');
  return 0;
}
