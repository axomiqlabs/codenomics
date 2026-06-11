import type { Collector } from './types.js';
import { claudeCodeCollector } from './claude-code.js';
import { codexCollector } from './codex.js';

export function allCollectors(): Collector[] {
  return [claudeCodeCollector, codexCollector];
}
