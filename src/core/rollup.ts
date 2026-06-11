// RollupV1 builder — the ONLY shape the future cloud sync will ever send.
// Aggregates per (day, vendor, model, project, source); carries token counts
// and activity numbers, never text. See PRIVACY.md.

import { SCHEMA_VERSION, type RollupV1, type SessionV1 } from './schema.js';

function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function buildRollups(sessions: SessionV1[]): RollupV1[] {
  const byKey = new Map<string, RollupV1>();
  for (const s of sessions) {
    const t = s.endedAt ?? s.startedAt;
    if (t === null) continue;
    const day = dayOf(t);
    for (const [model, m] of Object.entries(s.models)) {
      const key = `${day}|${s.vendor}|${model}|${s.project}|${s.source}`;
      let r = byKey.get(key);
      if (!r) {
        r = {
          schemaVersion: SCHEMA_VERSION,
          day,
          vendor: s.vendor,
          model,
          project: s.project,
          source: s.source,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 },
          sessions: 0,
          prompts: 0,
          commits: 0,
          activeMs: 0,
        };
        byKey.set(key, r);
      }
      r.tokens.input += m.input;
      r.tokens.output += m.output;
      r.tokens.cacheRead += m.cacheRead;
      r.tokens.cacheWrite5m += m.cacheWrite5m;
      r.tokens.cacheWrite1h += m.cacheWrite1h;
      r.tokens.reasoning += m.reasoning;
    }
    // session-level counters attach to the primary model's row to avoid double counting
    const primary = s.primaryModel ?? Object.keys(s.models)[0];
    if (primary) {
      const key = `${day}|${s.vendor}|${primary}|${s.project}|${s.source}`;
      const r = byKey.get(key);
      if (r) {
        r.sessions++;
        r.prompts += s.counts.userPrompts;
        r.commits += s.counts.commits ?? 0;
        r.activeMs += s.activeMs;
      }
    }
  }
  return [...byKey.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
