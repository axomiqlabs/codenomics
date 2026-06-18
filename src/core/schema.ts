// Normalized, versioned data model shared by collectors, metrics, server, reports
// and the (future) cloud sync. Token counts only — cost is always derived at read
// time from config (pricing + drivers), never baked into stored data.

export const SCHEMA_VERSION = 1 as const;

export type Vendor = 'claude-code' | 'codex' | 'gemini';
export type Source = 'human' | 'machine' | 'unknown';

export interface ModelUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number; // included in output for billing; tracked for visibility (Codex)
}

export interface SessionCounts {
  userPrompts: number;
  assistantTurns: number;
  toolCalls: number;
  /** null = this vendor's adapter cannot detect commits (capability-gated) */
  commits: number | null;
  sidechainCalls: number;
}

export interface SessionMeta {
  gitBranch?: string;
  cliVersion?: string;
  slashCommand?: string;
  firstPrompt?: string;
  lastAssistantText?: string;
}

export interface SessionV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  vendor: Vendor;
  /** vendor-native session id; globally unique as `${vendor}:${id}` */
  id: string;
  source: Source;
  /** normalized display key for grouping (derived from cwd/slug) */
  project: string;
  /** raw working directory when known */
  projectPath: string | null;
  startedAt: number | null;
  endedAt: number | null;
  wallMs: number;
  /** sum of inter-event gaps capped at the idle limit */
  activeMs: number;
  counts: SessionCounts;
  toolCounts: Record<string, number>;
  models: Record<string, ModelUsage>;
  primaryModel: string | null;
  meta: SessionMeta;
  /** vendor-namespaced extras, e.g. ext.codex = { planType } */
  ext?: Record<string, unknown>;
}

export interface IndexFileV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: number;
  sessions: SessionV1[];
}

/** Aggregate-only row for the future cloud sync. NEVER carries text fields. */
export interface RollupV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  /** UTC calendar day, YYYY-MM-DD */
  day: string;
  vendor: Vendor;
  model: string;
  project: string;
  source: Source;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    reasoning: number;
  };
  sessions: number;
  prompts: number;
  commits: number;
  activeMs: number;
}

/** A hashed project key — the ONLY representation of a project allowed to leave
 *  the machine. Minted exclusively by `hashProject()` (sync-client.ts); the brand
 *  makes it a type error to place a raw project name on the wire without hashing,
 *  so a new Phase-2 sync path cannot silently bypass `buildPayload`. */
export type ProjectHash = string & { readonly __projectHash: unique symbol };

/** Wire form of a rollup row: identical to {@link RollupV1} but `project` MUST be a
 *  hashed {@link ProjectHash}. This is the exact shape the sync client uploads. */
export interface RollupV1Wire extends Omit<RollupV1, 'project'> {
  project: ProjectHash;
}

export function sessionKey(s: Pick<SessionV1, 'vendor' | 'id'>): string {
  return `${s.vendor}:${s.id}`;
}

/**
 * Leading line of the recap prompt (see `buildPrompt` in `summarize.ts`). When
 * codenomics shells out to `claude -p` to write recaps, those runs leave their
 * own transcripts on disk; the collector would otherwise index them as human
 * sessions whose `firstPrompt` IS this marker. The engine uses it to reclassify
 * such self-generated sessions as `machine` so they stop polluting human stats,
 * stop being re-summarized (wasted spend), and never surface the prompt as a
 * dashboard recap. Keep this in exact sync with `buildPrompt`'s first line.
 */
export const RECAP_PROMPT_MARKER =
  'You are writing a one-line recap for a dashboard of past AI coding sessions.';

/** True if a session is codenomics' own `claude -p` recap-generation run. */
export function isSelfRecapSession(s: Pick<SessionV1, 'meta'>): boolean {
  return (s.meta.firstPrompt ?? '').startsWith(RECAP_PROMPT_MARKER);
}

export function emptyModelUsage(): ModelUsage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 };
}

export function totalTokens(m: ModelUsage): number {
  return m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
}

/** Pick the model with the most output tokens as the session's primary model. */
export function primaryModelOf(models: Record<string, ModelUsage>): string | null {
  let best: string | null = null;
  let bestOut = -1;
  for (const [name, m] of Object.entries(models)) {
    if (m.output > bestOut) { best = name; bestOut = m.output; }
  }
  return best;
}
