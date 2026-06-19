import { parseArgs } from 'node:util';
import { summarizeSessions } from '../../summarize.js';

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      limit: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      [
        'usage: codenomics summarize [--limit N]',
        '',
        'Generates AI recaps for recent sessions via the `claude` CLI (must be on PATH).',
        '',
        'Options:',
        '  --limit <N>   number of recent sessions to recap (default: 25, max: 200)',
      ].join('\n'),
    );
    return 0;
  }
  const limit = Math.max(1, Math.min(200, parseInt(values.limit ?? positionals[0] ?? '25', 10) || 25));
  const result = await summarizeSessions(limit, (line) => console.log(line));
  console.log(`recaps: ${result.written} written, ${result.failed} failed (${result.candidates} candidates)`);
  return result.failed && !result.written ? 1 : 0;
}
