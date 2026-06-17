import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  getPath,
  loadConfig,
  setPath,
  userConfigPath,
  validateConfig,
} from '../../core/config.js';

function readRaw(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRaw(file: string, obj: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // bare strings without quotes
  }
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [sub, key, ...rest] = positionals;

  if (values.help || !sub) {
    console.log(
      [
        'usage: npx codenomics config <get|set|unset|list|path> [key] [value] [--project]',
        '',
        '  get drivers.attentionUsdPerPrompt     read merged value',
        '  set drivers.attentionUsdPerPrompt 8   write to user config (--project: .codenomics.json in cwd)',
        '  set limits \'[{"id":"daily","metric":"costUsd","period":"day","max":50,"scope":"global"}]\'',
        '  unset pricing.gpt-5.5                 remove a key',
        '  list                                  merged effective config',
        '  path                                  config file locations',
      ].join('\n'),
    );
    return values.help ? 0 : 1;
  }

  const loaded = loadConfig();
  const targetFile = values.project ? path.join(process.cwd(), '.codenomics.json') : userConfigPath();

  switch (sub) {
    case 'list':
      console.log(JSON.stringify(loaded.config, null, 2));
      return 0;
    case 'path':
      console.log(`user:    ${loaded.userPath}${fs.existsSync(loaded.userPath) ? '' : ' (missing — run npx codenomics init)'}`);
      console.log(`project: ${loaded.projectPath ?? '(none found walking up from cwd)'}`);
      return 0;
    case 'get': {
      if (!key) {
        console.error('usage: npx codenomics config get <dotted.key>');
        return 1;
      }
      const v = getPath(loaded.config, key);
      console.log(v === undefined ? 'undefined' : JSON.stringify(v, null, 2));
      return v === undefined ? 1 : 0;
    }
    case 'set': {
      const rawValue = rest.join(' ');
      if (!key || rawValue === '') {
        console.error('usage: npx codenomics config set <dotted.key> <value> [--project]');
        return 1;
      }
      const obj = readRaw(targetFile);
      setPath(obj, key, parseValue(rawValue));
      const merged = loadConfig({ flags: obj });
      const problems = validateConfig(merged.config);
      if (problems.length) {
        for (const p of problems) console.error(`refusing to save: ${p}`);
        return 1;
      }
      writeRaw(targetFile, obj);
      console.log(`set ${key} in ${targetFile}`);
      return 0;
    }
    case 'unset': {
      if (!key) {
        console.error('usage: npx codenomics config unset <dotted.key> [--project]');
        return 1;
      }
      const obj = readRaw(targetFile);
      setPath(obj, key, undefined);
      writeRaw(targetFile, obj);
      console.log(`unset ${key} in ${targetFile}`);
      return 0;
    }
    default:
      console.error(`unknown subcommand: ${sub}`);
      return 1;
  }
}
