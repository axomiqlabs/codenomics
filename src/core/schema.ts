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

export function sessionKey(s: Pick<SessionV1, 'vendor' | 'id'>): string {
  return `${s.vendor}:${s.id}`;
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
