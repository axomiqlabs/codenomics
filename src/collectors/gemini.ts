// Gemini CLI collector — best effort. Gemini CLI only logs locally when
// telemetry is enabled (settings.json: telemetry.target = "local" with an
// outfile, or the bundled local OTEL collector). We parse OTEL log records in
// either of the shapes seen in the wild:
//   1. flat:  { "attributes": { "event.name": "gemini_cli.api_response", ... } }
//   2. OTLP:  { "attributes": [ { "key": "...", "value": { "stringValue": "..." } } ] }
// Files may be strict JSONL or concatenated pretty-printed JSON objects, so we
// split on balanced braces rather than newlines. One file can contain many
// sessions (grouped by session.id). Capabilities are accordingly narrow:
// no commits, no human/machine detection, no prompt text.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  SCHEMA_VERSION,
  emptyModelUsage,
  primaryModelOf,
  type ModelUsage,
  type SessionV1,
} from '../core/schema.js';
import type { Collector, DiscoveredFile, ParseResult } from './types.js';
import { ActivityTracker, findFiles } from './shared.js';

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** Flatten OTLP attribute arrays ([{key, value:{stringValue|intValue|...}}]) or pass through flat objects. */
function flattenAttributes(attrs: unknown): Record<string, unknown> {
  const flat = asObj(attrs);
  if (flat) return flat;
  const out: Record<string, unknown> = {};
  if (Array.isArray(attrs)) {
    for (const raw of attrs) {
      const kv = asObj(raw);
      if (!kv || typeof kv.key !== 'string') continue;
      const val = asObj(kv.value);
      if (!val) {
        out[kv.key] = kv.value;
        continue;
      }
      out[kv.key] =
        val.stringValue ?? val.intValue ?? val.doubleValue ?? val.boolValue ?? kv.value;
    }
  }
  return out;
}

/** Yield balanced top-level JSON objects from possibly pretty-printed concatenated output. */
export function* splitJsonObjects(text: string): Generator<Record<string, unknown>> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1)) as unknown;
          const o = asObj(v);
          if (o) yield o;
        } catch {
          // unbalanced/truncated tail: skip
        }
        start = -1;
      } else if (depth < 0) {
        depth = 0; // tolerate stray closers
      }
    }
  }
}

interface SessionAccum {
  activity: ActivityTracker;
  models: Record<string, ModelUsage>;
  userPrompts: number;
  toolCalls: number;
  apiResponses: number;
  toolCounts: Record<string, number>;
}

/** Walk a parsed record (or batched OTLP envelope) and emit every log record with event.name. */
function* logRecords(root: Record<string, unknown>): Generator<{ attrs: Record<string, unknown>; ts: string | undefined }> {
  // direct record shape
  if (root.attributes !== undefined) {
    const attrs = flattenAttributes(root.attributes);
    if (typeof attrs['event.name'] === 'string') {
      const ts =
        (typeof root.timestamp === 'string' && root.timestamp) ||
        (typeof root.observedTimestamp === 'string' && root.observedTimestamp) ||
        (typeof attrs['event.timestamp'] === 'string' && (attrs['event.timestamp'] as string)) ||
        undefined;
      yield { attrs, ts };
      return;
    }
  }
  // batched OTLP envelope: resourceLogs[].scopeLogs[].logRecords[]
  const resourceLogs = root.resourceLogs;
  if (Array.isArray(resourceLogs)) {
    for (const rl of resourceLogs) {
      const scopeLogs = asObj(rl)?.scopeLogs;
      if (!Array.isArray(scopeLogs)) continue;
      for (const sl of scopeLogs) {
        const records = asObj(sl)?.logRecords;
        if (!Array.isArray(records)) continue;
        for (const rec of records) {
          const r = asObj(rec);
          if (!r) continue;
          const attrs = flattenAttributes(r.attributes);
          if (typeof attrs['event.name'] !== 'string') continue;
          let ts: string | undefined;
          const nano = r.timeUnixNano ?? r.observedTimeUnixNano;
          if (typeof nano === 'string' || typeof nano === 'number') {
            const ms = Number(nano) / 1e6;
            if (Number.isFinite(ms) && ms > 0) ts = new Date(ms).toISOString();
          }
          yield { attrs, ts };
        }
      }
    }
  }
}

export const geminiCollector: Collector = {
  vendor: 'gemini',
  parserVersion: 1,
  capabilities: {
    commits: false,
    activeTime: 'approx',
    cacheWriteSplit: false,
    sourceDetection: false,
    promptText: false,
  },

  defaultRoots() {
    return [path.join(os.homedir(), '.gemini')];
  },

  async discover(roots: string[]): Promise<DiscoveredFile[]> {
    return roots.flatMap((r) =>
      findFiles(r, (n) => n === 'telemetry.log' || (n.startsWith('collector') && n.endsWith('.log'))),
    );
  },

  async parseFile(filePath: string): Promise<ParseResult> {
    const driftStats: Record<string, number> = {};
    const drift = (kind: string) => {
      driftStats[kind] = (driftStats[kind] || 0) + 1;
    };

    const text = fs.readFileSync(filePath, 'utf8');
    const bySession = new Map<string, SessionAccum>();

    const accumFor = (sid: string): SessionAccum => {
      let a = bySession.get(sid);
      if (!a) {
        a = { activity: new ActivityTracker(), models: {}, userPrompts: 0, toolCalls: 0, apiResponses: 0, toolCounts: {} };
        bySession.set(sid, a);
      }
      return a;
    };

    for (const obj of splitJsonObjects(text)) {
      for (const { attrs, ts } of logRecords(obj)) {
        const eventName = attrs['event.name'] as string;
        const sid = typeof attrs['session.id'] === 'string' ? (attrs['session.id'] as string) : '(unknown)';
        const acc = accumFor(sid);
        acc.activity.observe(ts);

        switch (eventName) {
          case 'gemini_cli.user_prompt':
            acc.userPrompts++;
            break;
          case 'gemini_cli.tool_call': {
            acc.toolCalls++;
            const name = typeof attrs.function_name === 'string' ? (attrs.function_name as string) : 'unknown';
            acc.toolCounts[name] = (acc.toolCounts[name] || 0) + 1;
            break;
          }
          case 'gemini_cli.api_response': {
            acc.apiResponses++;
            const model = typeof attrs.model === 'string' ? (attrs.model as string) : 'unknown';
            const m = (acc.models[model] ??= emptyModelUsage());
            const input = num(attrs.input_token_count);
            const cached = num(attrs.cached_content_token_count);
            m.calls++;
            m.input += Math.max(0, input - cached);
            m.cacheRead += cached;
            m.output += num(attrs.output_token_count);
            m.reasoning += num(attrs.thoughts_token_count);
            break;
          }
          case 'gemini_cli.config':
          case 'gemini_cli.api_request':
          case 'gemini_cli.api_error':
          case 'gemini_cli.flash_fallback':
          case 'gemini_cli.next_speaker_check':
            break;
          default:
            drift(`unknown-event:${eventName}`);
            break;
        }
      }
    }

    const sessions: SessionV1[] = [];
    for (const [sid, acc] of bySession) {
      if (Object.keys(acc.models).length === 0 && acc.userPrompts === 0) continue;
      sessions.push({
        schemaVersion: SCHEMA_VERSION,
        vendor: 'gemini',
        id: sid,
        source: 'unknown',
        project: '(gemini)', // cwd is not in telemetry; refined when upstream adds it
        projectPath: null,
        startedAt: acc.activity.firstTs,
        endedAt: acc.activity.lastTs,
        wallMs: acc.activity.wallMs,
        activeMs: acc.activity.activeMs,
        counts: {
          userPrompts: acc.userPrompts,
          assistantTurns: acc.apiResponses,
          toolCalls: acc.toolCalls,
          commits: null, // capability-gated: telemetry has no command text
          sidechainCalls: 0,
        },
        toolCounts: acc.toolCounts,
        models: acc.models,
        primaryModel: primaryModelOf(acc.models),
        meta: {},
      });
    }

    return { sessions, driftStats };
  },
};
