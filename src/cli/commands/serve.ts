import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig } from '../../core/config.js';
import { startServer } from '../../server/server.js';

export async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      [
        'usage: npx codenomics serve [--port N] [--host addr] [--open]',
        '',
        'Options:',
        '  --port <N>      port to listen on (default: config server.port)',
        '  --host <addr>   bind address (default: config server.host, typically 127.0.0.1)',
        '  --open          open the dashboard in the default browser after starting',
      ].join('\n'),
    );
    return 0;
  }

  const { config, problems } = loadConfig();
  for (const p of problems) console.error(`config warning: ${p}`);

  const port = values.port ? parseInt(values.port, 10) : config.server.port;
  const host = values.host ?? config.server.host;
  startServer({ port, host });

  if (values.open) {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {});
  }

  return new Promise(() => {}); // run until killed
}
