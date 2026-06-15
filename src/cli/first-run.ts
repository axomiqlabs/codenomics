// One-time transparency disclosure. Before codenomics first reads any local
// agent transcripts, it states — on this machine — exactly what it scans
// (read-only), where it stores its own data, and that nothing is uploaded.
//
// Acknowledgement is recorded under the data dir so it shows once. In a
// non-interactive context (PM2, CI, piped stdin) there is no one to press a
// key, so we print the notice and auto-accept rather than block forever.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, loadConfig } from '../core/config.js';
import { allCollectors } from '../collectors/registry.js';

// Bump when the disclosure text materially changes to re-prompt users.
const DISCLOSURE_VERSION = 1;

const VENDOR_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code transcripts',
  codex: 'Codex CLI rollouts',
  gemini: 'Gemini CLI telemetry',
};

function ackPath(): string {
  return path.join(dataDir(), '.disclosure-ack.json');
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function alreadyAcknowledged(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(ackPath(), 'utf8')) as { version?: number };
    return typeof raw.version === 'number' && raw.version >= DISCLOSURE_VERSION;
  } catch {
    return false;
  }
}

function recordAck(interactive: boolean): void {
  const dir = dataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      ackPath(),
      JSON.stringify({ version: DISCLOSURE_VERSION, acceptedAt: new Date().toISOString(), interactive }, null, 2),
    );
  } catch {
    // best-effort: if we can't persist, we'll simply disclose again next run
  }
}

function disclosureText(): string {
  const { config } = loadConfig();
  const reads: string[] = [];
  for (const collector of allCollectors()) {
    const vcfg = config.collectors[collector.vendor];
    if (vcfg && vcfg.enabled === false) continue;
    const roots = vcfg?.root ? [path.resolve(vcfg.root)] : collector.defaultRoots();
    const label = VENDOR_LABEL[collector.vendor] ?? collector.vendor;
    for (const r of roots) reads.push(`  • ${tilde(r).padEnd(22)} (${label})`);
  }
  return [
    '',
    'Codenomics — first run',
    '',
    'What it reads (read-only, on this machine):',
    ...reads,
    '',
    'What it writes:',
    `  • ${tilde(dataDir()).padEnd(22)} (local aggregates + cache)`,
    '',
    'Network: none. Your transcripts never leave this machine.',
    'Details: PRIVACY.md',
    '',
  ].join('\n');
}

/**
 * Show the one-time disclosure if it hasn't been acknowledged. Returns true to
 * continue, false if the user declined (caller should abort). Never throws.
 */
export async function ensureDisclosure(): Promise<boolean> {
  if (alreadyAcknowledged()) return true;
  if (process.env.CODENOMICS_ACCEPT_DISCLOSURE === '1') {
    recordAck(false);
    return true;
  }

  process.stdout.write(disclosureText());

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    // No one to prompt (PM2/CI/pipe): disclose and proceed, don't hang.
    process.stdout.write('Non-interactive run — proceeding. Set CODENOMICS_ACCEPT_DISCLOSURE=1 to silence.\n\n');
    recordAck(false);
    return true;
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press Enter to accept and continue (or Ctrl-C to abort)… ');
  } finally {
    rl.close();
  }
  process.stdout.write('\n');
  recordAck(true);
  return true;
}
