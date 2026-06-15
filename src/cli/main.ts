#!/usr/bin/env node
// codenomics CLI — thin dispatcher with lazy imports so `npx codenomics <cmd>`
// cold-starts fast (only the invoked command's module loads).

const COMMANDS: Record<string, { summary: string; load: () => Promise<{ run: (argv: string[]) => Promise<number> }> }> = {
  init: { summary: 'Detect vendors, write user config, optionally import old data', load: () => import('./commands/init.js') },
  index: { summary: 'Scan agent logs into the local index (incremental)', load: () => import('./commands/index-cmd.js') },
  serve: { summary: 'Run the local dashboard (127.0.0.1 only)', load: () => import('./commands/serve.js') },
  report: { summary: 'Generate weekly/monthly reports (md/html, optional Slack)', load: () => import('./commands/report.js') },
  config: { summary: 'Get/set config values (drivers, limits, pricing...)', load: () => import('./commands/config-cmd.js') },
  summarize: { summary: 'AI recaps for recent sessions (requires `claude` CLI)', load: () => import('./commands/summarize-cmd.js') },
  doctor: { summary: 'Diagnose collectors, parse errors, format drift, config', load: () => import('./commands/doctor.js') },
  sync: { summary: 'Preview the (future) cloud sync payload — aggregates only', load: () => import('./commands/sync.js') },
};

async function readVersion(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const url = new URL('../../package.json', import.meta.url);
  try {
    const pkg = JSON.parse(await readFile(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  const lines = [
    'codenomics — decode the true economics of your AI coding agents',
    '',
    'Usage: codenomics <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`),
    '',
    'Run `codenomics <command> --help` for command options.',
  ];
  console.log(lines.join('\n'));
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return cmd ? 0 : 1;
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(await readVersion());
    return 0;
  }

  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`unknown command: ${cmd}\n`);
    printHelp();
    return 1;
  }
  // One-time transparency disclosure before any local data is read.
  const { ensureDisclosure } = await import('./first-run.js');
  if (!(await ensureDisclosure())) return 1;
  const mod = await entry.load();
  return mod.run(rest);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
