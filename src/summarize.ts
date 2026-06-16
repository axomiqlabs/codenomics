// AI session recaps via headless `claude -p` (haiku). Only claude-code human
// sessions with prompt text qualify. Cached forever in summaries.json keyed
// `${vendor}:${sessionId}` — one API call per session, ever.

import { spawn } from 'node:child_process';
import { isSelfRecapSession, RECAP_PROMPT_MARKER, sessionKey, type SessionV1 } from './core/schema.js';
import { readIndex, readSummaries, writeSummaries } from './core/store.js';

const MODEL = 'claude-haiku-4-5';
const CONCURRENCY = 3;

function claudeRecap(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', MODEL], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d));
    p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
    p.on('error', () => resolve(null));
    p.stdin.write(prompt);
    p.stdin.end();
  });
}

function buildPrompt(s: SessionV1): string {
  return [
    RECAP_PROMPT_MARKER,
    'Based on the opening request and the final assistant message below, write 1-2 plain sentences',
    'describing what was worked on and (if evident) the outcome. No preamble, no markdown, no quotes.',
    '',
    `Project: ${s.project}`,
    s.meta.slashCommand ? `Invoked via: ${s.meta.slashCommand}` : '',
    '',
    '--- OPENING REQUEST ---',
    s.meta.firstPrompt || '(none recorded)',
    '',
    '--- FINAL ASSISTANT MESSAGE (truncated) ---',
    s.meta.lastAssistantText || '(none recorded)',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface SummarizeResult {
  candidates: number;
  written: number;
  failed: number;
}

export async function summarizeSessions(limit: number, log: (line: string) => void = () => {}): Promise<SummarizeResult> {
  const index = readIndex();
  const sums = readSummaries();

  const totalOut = (s: SessionV1) => Object.values(s.models).reduce((a, m) => a + m.output, 0);
  const candidates = index.sessions
    .filter(
      (s) =>
        s.vendor === 'claude-code' &&
        s.source === 'human' &&
        !isSelfRecapSession(s) && // never recap our own recap-generation runs
        !sums[sessionKey(s)] &&
        (s.meta.firstPrompt || s.meta.lastAssistantText) &&
        s.counts.userPrompts > 0 &&
        totalOut(s) > 500,
    )
    .slice(0, limit);

  let written = 0;
  let failed = 0;
  let done = 0;
  const queue = [...candidates];

  async function worker(): Promise<void> {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      const text = await claudeRecap(buildPrompt(s));
      if (text) {
        sums[sessionKey(s)] = { text: text.slice(0, 500), at: Date.now() };
        writeSummaries(sums); // persist as we go
        written++;
      } else {
        failed++;
      }
      done++;
      log(`${done}/${candidates.length} ${s.id.slice(0, 8)} ${text ? 'ok' : 'FAILED'}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { candidates: candidates.length, written, failed };
}
