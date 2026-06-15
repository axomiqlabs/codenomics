// Claude Code collector — parses ~/.claude/projects/**/*.jsonl transcripts.
// Port of the original claude-stats indexer: Claude Code writes one JSONL line
// per content block sharing the same message.id/usage; we keep the LAST usage
// seen per message.id (streamed chunks grow monotonically).

import os from 'node:os';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  emptyModelUsage,
  primaryModelOf,
  type ModelUsage,
  type SessionV1,
} from '../core/schema.js';
import type { Collector, DiscoveredFile, ParseResult } from './types.js';
import { ActivityTracker, countCommits, findFiles, isControlSlashCommand, projectKeyFromPath, readJsonlObjects, truncate } from './shared.js';

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** strip date suffix and context-window markers: claude-opus-4-8-20260115[1m] -> claude-opus-4-8.
 *  Must match pricing.ts normalizeModel so one model keys identically across
 *  collector, rollup, dashboard and pricing (else a model fragments by date). */
function normalizeModel(model: string): string {
  return model.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export const claudeCodeCollector: Collector = {
  vendor: 'claude-code',
  parserVersion: 5, // detect deeply-nested (workflow) subagent transcripts for folding
  capabilities: {
    commits: true,
    activeTime: 'exact',
    cacheWriteSplit: true,
    sourceDetection: true,
    promptText: true,
  },

  defaultRoots() {
    return [path.join(os.homedir(), '.claude', 'projects')];
  },

  async discover(roots: string[]): Promise<DiscoveredFile[]> {
    return roots.flatMap((r) => findFiles(r, (n) => n.endsWith('.jsonl')));
  },

  async parseFile(filePath: string): Promise<ParseResult> {
    const driftStats: Record<string, number> = {};
    const drift = (kind: string) => {
      driftStats[kind] = (driftStats[kind] || 0) + 1;
    };

    const activity = new ActivityTracker();
    const usageById = new Map<string, { model: string; usage: RawUsage }>();
    let userPrompts = 0;
    let assistantTurns = 0;
    let sidechainCalls = 0;
    let toolCalls = 0;
    let commits = 0;
    const toolCounts: Record<string, number> = {};
    let firstPrompt: string | undefined;
    let lastAssistantText: string | undefined;
    let gitBranch: string | undefined;
    let cliVersion: string | undefined;
    let slashCommand: string | undefined;
    let entrypoint: string | undefined;
    let cwd: string | null = null;

    for await (const e of readJsonlObjects(filePath, () => drift('malformed-line'))) {
      activity.observe(asStr(e.timestamp) ?? undefined);
      if (typeof e.gitBranch === 'string' && e.gitBranch) gitBranch = e.gitBranch;
      if (typeof e.version === 'string') cliVersion = e.version;
      if (typeof e.entrypoint === 'string' && !entrypoint) entrypoint = e.entrypoint;
      if (typeof e.cwd === 'string' && !cwd) cwd = e.cwd;

      const type = asStr(e.type);

      if (type === 'user' && e.message && !e.isSidechain && !e.isMeta) {
        const msg = asObj(e.message);
        const c = msg?.content;
        let text: string | null = null;
        if (typeof c === 'string') {
          text = c;
        } else if (Array.isArray(c)) {
          const hasToolResult = c.some((b) => asObj(b)?.type === 'tool_result');
          if (!hasToolResult) {
            const tb = c.map(asObj).find((b) => b?.type === 'text' && typeof b.text === 'string');
            if (tb) text = tb.text as string;
          }
        }
        if (text && !text.startsWith('<') && !text.startsWith('Caveat:')) {
          userPrompts++;
          if (!firstPrompt) firstPrompt = truncate(text, 400);
        } else if (text && text.startsWith('<command-name>')) {
          const cmd = (text.match(/<command-name>([^<]+)<\/command-name>/) || [])[1] ?? '';
          // built-in control commands (/clear, /compact, ...) aren't work prompts:
          // don't count them, don't let them be the recap or the session's command.
          if (!isControlSlashCommand(cmd)) {
            userPrompts++;
            if (!slashCommand) slashCommand = cmd;
            if (!firstPrompt) firstPrompt = truncate(text.replace(/<[^>]+>/g, ' ').trim(), 400);
          }
        }
        continue;
      }

      if (type === 'assistant' && e.message) {
        const msg = asObj(e.message)!;
        if (e.isSidechain) sidechainCalls++;
        else assistantTurns++;
        const id = asStr(msg.id);
        const model = asStr(msg.model);
        const usage = asObj(msg.usage);
        if (id && usage && model && model !== '<synthetic>') {
          usageById.set(id, { model, usage: usage as RawUsage });
        }
        if (Array.isArray(msg.content)) {
          for (const raw of msg.content) {
            const b = asObj(raw);
            if (!b) continue;
            if (b.type === 'tool_use') {
              toolCalls++;
              const name = asStr(b.name) ?? 'unknown';
              toolCounts[name] = (toolCounts[name] || 0) + 1;
              const input = asObj(b.input);
              if (name === 'Bash' && input && typeof input.command === 'string') {
                commits += countCommits(input.command);
              }
            } else if (b.type === 'text' && typeof b.text === 'string' && !e.isSidechain) {
              lastAssistantText = truncate(b.text, 600);
            }
          }
        }
        continue;
      }

      const KNOWN_PASSIVE = [
        'summary', 'system', 'file-history-snapshot', 'attachment', 'last-prompt', 'ai-title',
        'queue-operation', 'mode', 'progress', 'permission-mode', 'agent-name', 'custom-title',
        'started', 'result', 'fork-context-ref',
      ];
      if (type !== 'user' && type !== 'assistant' && type !== null && !KNOWN_PASSIVE.includes(type)) {
        drift(`unknown-type:${type}`);
      }
    }

    if (usageById.size === 0 && userPrompts === 0) return { sessions: [], driftStats };

    // Aggregate usage per model from the deduped per-message map
    const models: Record<string, ModelUsage> = {};
    for (const { model, usage } of usageById.values()) {
      const key = normalizeModel(model);
      const m = (models[key] ??= emptyModelUsage());
      m.calls++;
      m.input += num(usage.input_tokens);
      m.output += num(usage.output_tokens);
      m.cacheRead += num(usage.cache_read_input_tokens);
      const cc = usage.cache_creation;
      if (cc && cc.ephemeral_5m_input_tokens != null) {
        m.cacheWrite5m += num(cc.ephemeral_5m_input_tokens);
        m.cacheWrite1h += num(cc.ephemeral_1h_input_tokens);
      } else {
        m.cacheWrite5m += num(usage.cache_creation_input_tokens); // old format: assume 5m
      }
    }

    // project slug dir name is the fallback when no cwd was recorded
    const slug = path.basename(path.dirname(filePath));

    // Subagent transcripts live somewhere under a `subagents/` dir. The simple
    // case is <project>/<parentSessionId>/subagents/agent-*.jsonl, but workflow-
    // spawned agents nest deeper, e.g.
    //   <project>/<parentSessionId>/subagents/workflows/<wf>/agent-*.jsonl.
    // Locate the `subagents` segment anywhere in the path; the parent session id
    // is the directory directly above it, and the project slug is the dir above
    // that. Usage lives ONLY in these files, so the engine folds them into the
    // parent after collection.
    const segments = filePath.split(path.sep);
    const si = segments.lastIndexOf('subagents');
    const parentSessionId = si > 0 ? (segments[si - 1] ?? null) : null;
    const subagentSlug = si >= 2 ? (segments[si - 2] ?? slug) : slug;

    const session: SessionV1 = {
      schemaVersion: SCHEMA_VERSION,
      vendor: 'claude-code',
      id: path.basename(filePath, '.jsonl'),
      source: parentSessionId
        ? 'machine' // standalone fallback only; normally merged into the parent
        : entrypoint === 'sdk-cli' ? 'machine' : entrypoint === 'cli' ? 'human' : 'unknown',
      project: cwd ? projectKeyFromPath(cwd) : parentSessionId ? subagentSlug : slug,
      projectPath: cwd,
      startedAt: activity.firstTs,
      endedAt: activity.lastTs,
      wallMs: activity.wallMs,
      activeMs: activity.activeMs,
      counts: { userPrompts, assistantTurns, toolCalls, commits, sidechainCalls },
      toolCounts,
      models,
      primaryModel: primaryModelOf(models),
      meta: {
        ...(gitBranch ? { gitBranch } : {}),
        ...(cliVersion ? { cliVersion } : {}),
        ...(slashCommand ? { slashCommand } : {}),
        ...(firstPrompt ? { firstPrompt } : {}),
        ...(lastAssistantText ? { lastAssistantText } : {}),
      },
      ...(parentSessionId ? { ext: { claudeCode: { parentSessionId } } } : {}),
    };

    return { sessions: [session], driftStats };
  },
};
