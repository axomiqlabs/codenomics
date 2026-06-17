// Single source of truth for the benchmark / auto-sync consent. The exact same
// wording is shown by the CLI (`benchmark join`) and the dashboard join flow, and
// must match what `sync` actually uploads and what PRIVACY.md documents. Bump the
// version when the wording materially changes to re-consent users.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';

export const BENCHMARK_CONSENT_VERSION = 1;

/** What auto-sync sends and what it never sends — verbatim, payload-accurate. */
export const BENCHMARK_CONSENT_TEXT = [
  'Join the benchmark — what this shares:',
  '',
  '  Auto-sync uploads AGGREGATES ONLY, every 12 hours:',
  '    • day, vendor, model, project key (HASHED before it leaves this machine),',
  '      human/machine flag, token counts, session/prompt/commit counts, active time.',
  '',
  '  It NEVER uploads: prompts, code, transcripts, tool output, or file paths.',
  '',
  '  • Your org is an opaque id; your email is stored separately (for opt-out + updates).',
  '  • Comparisons stay withheld until ≥5 orgs contribute (k-anonymity).',
  '  • Preview your exact payload anytime:  codenomics sync',
  '  • Opt out anytime:  codenomics benchmark leave',
  '',
  'Details: PRIVACY.md',
].join('\n');

interface ConsentAck {
  version: number;
  email: string;
  acceptedAt: string;
}

function ackPath(): string {
  return path.join(dataDir(), '.benchmark-consent.json');
}

export function recordBenchmarkConsent(email: string): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const ack: ConsentAck = { version: BENCHMARK_CONSENT_VERSION, email, acceptedAt: new Date().toISOString() };
    fs.writeFileSync(ackPath(), JSON.stringify(ack, null, 2) + '\n');
  } catch {
    // best-effort
  }
}

export function benchmarkConsent(): ConsentAck | null {
  try {
    const raw = JSON.parse(fs.readFileSync(ackPath(), 'utf8')) as Partial<ConsentAck>;
    if (typeof raw.version === 'number' && raw.version >= BENCHMARK_CONSENT_VERSION) {
      return { version: raw.version, email: String(raw.email ?? ''), acceptedAt: String(raw.acceptedAt ?? '') };
    }
    return null;
  } catch {
    return null;
  }
}
