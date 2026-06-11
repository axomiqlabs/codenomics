// API-equivalent pricing. Built-in table below + per-model overrides from
// config (`pricing.<model>`). Cost is ALWAYS derived at read time — never
// stored — so editing pricing or overrides takes effect instantly.
//
// Built-ins are maintained best-effort and WILL drift as vendors change
// pricing; override any model via config. Anthropic cache economics: read =
// 0.1x input, 5m write = 1.25x, 1h write = 2x. OpenAI: cached input = 0.1x,
// no write charge. Subscription users: read $ as a normalized compute meter.

import type { CodenomicsConfig, PricingOverride } from './config.js';
import type { ModelUsage } from './schema.js';

export interface ResolvedPricing {
  /** $ per MTok */
  inUsd: number;
  outUsd: number;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
}

interface BuiltinEntry {
  in: number;
  out: number;
  cacheReadMult?: number; // default 0.1
  cacheWriteMult?: { m5: number; h1: number }; // default 1.25 / 2 (Anthropic); 0/0 for vendors without write charges
}

// Exact-prefix entries first; family fallbacks below. $/MTok.
const BUILTIN: Record<string, BuiltinEntry> = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'gpt-5-mini': { in: 0.25, out: 2, cacheWriteMult: { m5: 0, h1: 0 } },
  'gpt-5': { in: 1.25, out: 10, cacheWriteMult: { m5: 0, h1: 0 } }, // covers gpt-5.x via prefix
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cacheReadMult: 0.25, cacheWriteMult: { m5: 0, h1: 0 } },
  'gemini-2.5-pro': { in: 1.25, out: 10, cacheReadMult: 0.25, cacheWriteMult: { m5: 0, h1: 0 } },
  'gemini-3-flash': { in: 0.3, out: 2.5, cacheReadMult: 0.25, cacheWriteMult: { m5: 0, h1: 0 } },
  'gemini-3-pro': { in: 2, out: 12, cacheReadMult: 0.25, cacheWriteMult: { m5: 0, h1: 0 } },
};

const FAMILY_FALLBACKS: Array<[RegExp, BuiltinEntry]> = [
  [/fable/, { in: 10, out: 50 }],
  [/opus/, { in: 5, out: 25 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku/, { in: 1, out: 5 }],
  [/gpt/, { in: 1.25, out: 10, cacheWriteMult: { m5: 0, h1: 0 } }],
  [/gemini.*flash/, { in: 0.3, out: 2.5, cacheReadMult: 0.25, cacheWriteMult: { m5: 0, h1: 0 } }],
  [/gemini/, { in: 1.25, out: 10, cacheReadMult: 0.25, cacheWriteMult: { m5: 0, h1: 0 } }],
];

function normalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, '').replace(/\[1m\]$/, '');
}

function resolveBuiltin(model: string): BuiltinEntry | null {
  const m = normalizeModel(model);
  if (BUILTIN[m]) return BUILTIN[m];
  // longest-prefix match so gpt-5-mini wins over gpt-5 for gpt-5-mini-2026xx
  let best: BuiltinEntry | null = null;
  let bestLen = 0;
  for (const [key, entry] of Object.entries(BUILTIN)) {
    if (m.startsWith(key) && key.length > bestLen) {
      best = entry;
      bestLen = key.length;
    }
  }
  if (best) return best;
  for (const [re, entry] of FAMILY_FALLBACKS) if (re.test(m)) return entry;
  return null;
}

function fromOverride(o: PricingOverride): ResolvedPricing {
  return {
    inUsd: o.in,
    outUsd: o.out,
    cacheReadUsd: o.cacheRead ?? o.in * 0.1,
    cacheWrite5mUsd: o.cacheWrite5m ?? o.in * 1.25,
    cacheWrite1hUsd: o.cacheWrite1h ?? o.in * 2,
  };
}

function fromBuiltin(e: BuiltinEntry): ResolvedPricing {
  return {
    inUsd: e.in,
    outUsd: e.out,
    cacheReadUsd: e.in * (e.cacheReadMult ?? 0.1),
    cacheWrite5mUsd: e.in * (e.cacheWriteMult?.m5 ?? 1.25),
    cacheWrite1hUsd: e.in * (e.cacheWriteMult?.h1 ?? 2),
  };
}

/** Resolve pricing for a model: config override (exact, then prefix) > builtin. */
export function priceFor(model: string, cfg: Pick<CodenomicsConfig, 'pricing'>): ResolvedPricing | null {
  const m = normalizeModel(model);
  const exact = cfg.pricing[m] ?? cfg.pricing[model];
  if (exact) return fromOverride(exact);
  for (const [key, o] of Object.entries(cfg.pricing)) {
    if (m.startsWith(key)) return fromOverride(o);
  }
  const builtin = resolveBuiltin(model);
  return builtin ? fromBuiltin(builtin) : null;
}

/** API-equivalent $ for one model's usage; null when the model is unpriced. */
export function usageCostUsd(model: string, u: ModelUsage, cfg: Pick<CodenomicsConfig, 'pricing'>): number | null {
  const p = priceFor(model, cfg);
  if (!p) return null;
  return (
    (u.input * p.inUsd +
      u.output * p.outUsd +
      u.cacheRead * p.cacheReadUsd +
      u.cacheWrite5m * p.cacheWrite5mUsd +
      u.cacheWrite1h * p.cacheWrite1hUsd) /
    1e6
  );
}
