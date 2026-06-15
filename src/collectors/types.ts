// Collector contract. Adapters are pure parse functions over discovered files;
// the engine owns caching, invalidation, and error quarantine.

import type { SessionV1, Vendor } from '../core/schema.js';

export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface CollectorCapabilities {
  /** can this vendor's logs reveal git commits? */
  commits: boolean;
  activeTime: 'exact' | 'approx' | 'none';
  /** 5m/1h cache-write split (Claude only) */
  cacheWriteSplit: boolean;
  /** human vs machine session detection */
  sourceDetection: boolean;
  /** prompt/recap text available */
  promptText: boolean;
  /** parser/token-semantics not yet validated against real logs; surface a warning */
  experimental?: boolean;
}

export interface ParseResult {
  sessions: SessionV1[];
  /** unrecognized event types seen while parsing — drift observability for `doctor` */
  driftStats: Record<string, number>;
}

export interface Collector {
  vendor: Vendor;
  /** bump to invalidate this vendor's cache entries after parser changes */
  parserVersion: number;
  capabilities: CollectorCapabilities;
  /** candidate log roots on this machine (existence not required) */
  defaultRoots(): string[];
  discover(roots: string[]): Promise<DiscoveredFile[]>;
  parseFile(path: string): Promise<ParseResult>;
}
