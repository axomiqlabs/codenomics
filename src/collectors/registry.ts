import type { Collector } from './types.js';
import { claudeCodeCollector } from './claude-code.js';
import { codexCollector } from './codex.js';
import { geminiCollector } from './gemini.js';

export function allCollectors(): Collector[] {
  return [claudeCodeCollector, codexCollector, geminiCollector];
}
