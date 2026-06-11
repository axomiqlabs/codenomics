// Codex CLI collector — parses ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
//
// Token semantics (ground-truthed against real rollouts, Codex CLI 0.125):
// `event_msg` payloads of type `token_count` carry `info` (sometimes null) with
// BOTH `total_token_usage` (session-cumulative) and `last_token_usage` (per-turn).
// We prefer `last_token_usage`; when only totals are present we take the delta
// against the previous cumulative and clamp counter resets (post-compaction) by
// treating the new total as the delta. `input_tokens` INCLUDES
// `cached_input_tokens`; we store uncached input and cacheRead separately.

import os from 'node:os';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  emptyModelUsage,
  primaryModelOf,
  type ModelUsage,
  type SessionV1,
  type Source,
} from '../core/schema.js';
import type { Collector, DiscoveredFile, ParseResult } from './types.js';
import { ActivityTracker, COMMIT_RE, findFiles, projectKeyFromPath, readJsonlObjects, truncate } from './shared.js';

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function commandFromArguments(args: unknown): string | null {
  if (typeof args !== 'string') return null;
  try {
    const parsed = asObj(JSON.parse(args));
    if (!parsed) return null;
    return asStr(parsed.cmd) ?? asStr(parsed.command);
  } catch {
    return null;
  }
}

export const codexCollector: Collector = {
  vendor: 'codex',
  parserVersion: 1,
  capabilities: {
    commits: true,
    activeTime: 'exact',
    cacheWriteSplit: false, // OpenAI reports cache reads only
    sourceDetection: true,
    promptText: true,
  },

  defaultRoots() {
    return [path.join(os.homedir(), '.codex', 'sessions')];
  },

  async discover(roots: string[]): Promise<DiscoveredFile[]> {
    return roots.flatMap((r) => findFiles(r, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')));
  },

  async parseFile(filePath: string): Promise<ParseResult> {
    const driftStats: Record<string, number> = {};
    const drift = (kind: string) => {
      driftStats[kind] = (driftStats[kind] || 0) + 1;
    };

    const activity = new ActivityTracker();
    const models: Record<string, ModelUsage> = {};
    let id = path.basename(filePath, '.jsonl').replace(/^rollout-/, '');
    let source: Source = 'unknown';
    let projectPath: string | null = null;
    let gitBranch: string | undefined;
    let cliVersion: string | undefined;
    let firstPrompt: string | undefined;
    let lastAssistantText: string | undefined;
    let planType: string | undefined;
    let agentRole: string | undefined;
    let currentModel = 'unknown';
    let userPrompts = 0;
    let assistantTurns = 0;
    let toolCalls = 0;
    let commits = 0;
    const toolCounts: Record<string, number> = {};
    // cumulative totals from the previous token_count, for the delta fallback
    let prevTotal: TokenUsage | null = null;

    const usageFor = (model: string): ModelUsage => (models[model] ??= emptyModelUsage());

    const addUsage = (model: string, turn: TokenUsage) => {
      const m = usageFor(model);
      const input = num(turn.input_tokens);
      const cached = num(turn.cached_input_tokens);
      if (input === 0 && num(turn.output_tokens) === 0) return;
      m.calls++;
      m.input += Math.max(0, input - cached);
      m.cacheRead += cached;
      m.output += num(turn.output_tokens);
      m.reasoning += num(turn.reasoning_output_tokens);
    };

    for await (const e of readJsonlObjects(filePath, () => drift('malformed-line'))) {
      activity.observe(asStr(e.timestamp) ?? undefined);
      const type = asStr(e.type);
      const payload = asObj(e.payload);

      switch (type) {
        case 'session_meta': {
          if (!payload) break;
          id = asStr(payload.id) ?? id;
          const cwd = asStr(payload.cwd);
          if (cwd) projectPath = cwd;
          cliVersion = asStr(payload.cli_version) ?? undefined;
          const git = asObj(payload.git);
          if (git) gitBranch = asStr(git.branch) ?? undefined;
          const src = asObj(payload.source);
          if (src && src.subagent !== undefined) {
            source = 'machine';
            const sub = asObj(src.subagent);
            const spawn = sub ? asObj(sub.thread_spawn) : null;
            agentRole = asStr(payload.agent_role) ?? (spawn ? (asStr(spawn.agent_role) ?? undefined) : undefined);
          } else {
            const originator = asStr(payload.originator);
            source = originator === null || originator.includes('tui') ? 'human' : 'machine';
          }
          break;
        }

        case 'turn_context': {
          if (!payload) break;
          currentModel = asStr(payload.model) ?? currentModel;
          if (!projectPath) projectPath = asStr(payload.cwd);
          break;
        }

        case 'event_msg': {
          if (!payload) break;
          const pt = asStr(payload.type);
          switch (pt) {
            case 'user_message': {
              userPrompts++;
              const msg = asStr(payload.message);
              if (msg && !firstPrompt) firstPrompt = truncate(msg, 400);
              break;
            }
            case 'agent_message': {
              assistantTurns++;
              const msg = asStr(payload.message);
              if (msg) lastAssistantText = truncate(msg, 600);
              break;
            }
            case 'token_count': {
              const info = asObj(payload.info);
              const rateLimits = asObj(payload.rate_limits);
              if (rateLimits) planType = asStr(rateLimits.plan_type) ?? planType;
              if (!info) break;
              const last = asObj(info.last_token_usage) as TokenUsage | null;
              const total = asObj(info.total_token_usage) as TokenUsage | null;
              // The CLI re-emits token_count without consuming tokens (e.g. UI
              // refresh): identical cumulative totals ⇒ not a new turn, skip.
              if (total && prevTotal && (['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'] as const)
                .every((k) => num(total[k]) === num(prevTotal![k]))) {
                break;
              }
              if (last) {
                addUsage(currentModel, last);
              } else if (total) {
                const prev = prevTotal;
                const delta = (cur: number, p: number) => (cur >= p ? cur - p : cur); // clamp counter resets
                addUsage(currentModel, {
                  input_tokens: delta(num(total.input_tokens), num(prev?.input_tokens)),
                  cached_input_tokens: delta(num(total.cached_input_tokens), num(prev?.cached_input_tokens)),
                  output_tokens: delta(num(total.output_tokens), num(prev?.output_tokens)),
                  reasoning_output_tokens: delta(num(total.reasoning_output_tokens), num(prev?.reasoning_output_tokens)),
                });
              }
              if (total) prevTotal = total;
              break;
            }
            default:
              // exec_command_begin/end, patch_apply_*, task_started... — not signals we read
              break;
          }
          break;
        }

        case 'response_item': {
          if (!payload) break;
          const pt = asStr(payload.type);
          if (pt === 'function_call' || pt === 'custom_tool_call') {
            toolCalls++;
            const name = asStr(payload.name) ?? 'unknown';
            toolCounts[name] = (toolCounts[name] || 0) + 1;
            const cmd = commandFromArguments(payload.arguments);
            if (cmd !== null && COMMIT_RE.test(cmd)) commits++;
          }
          // message/reasoning/function_call_output items carry no metrics we need
          break;
        }

        case 'compacted':
        case 'turn_aborted':
          break;

        default:
          drift(`unknown-type:${type ?? 'none'}`);
          break;
      }
    }

    const hasUsage = Object.keys(models).length > 0;
    if (!hasUsage && userPrompts === 0) return { sessions: [], driftStats };

    const session: SessionV1 = {
      schemaVersion: SCHEMA_VERSION,
      vendor: 'codex',
      id,
      source,
      project: projectPath ? projectKeyFromPath(projectPath) : '(unknown)',
      projectPath,
      startedAt: activity.firstTs,
      endedAt: activity.lastTs,
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      counts: { userPrompts, assistantTurns, toolCalls, commits, sidechainCalls: 0 },
      toolCounts,
      models,
      primaryModel: primaryModelOf(models),
      meta: {
        ...(gitBranch ? { gitBranch } : {}),
        ...(cliVersion ? { cliVersion } : {}),
        ...(firstPrompt ? { firstPrompt } : {}),
        ...(lastAssistantText ? { lastAssistantText } : {}),
      },
      ...(planType || agentRole ? { ext: { codex: { ...(planType ? { planType } : {}), ...(agentRole ? { agentRole } : {}) } } } : {}),
    };

    return { sessions: [session], driftStats };
  },
};
