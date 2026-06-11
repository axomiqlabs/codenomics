#!/usr/bin/env node
// Scrub a real agent transcript into a committable test fixture: redact every
// prompt/code/output string while preserving structure and the signals the
// collectors parse (event types, ids, timestamps, usage, models, text prefixes
// that drive classification, and git-commit commands for commit detection).
//
// Usage: node scripts/scrub-fixture.mjs <claude-code|codex> <in.jsonl> <out.jsonl>

import fs from 'node:fs';

const [vendor, inPath, outPath] = process.argv.slice(2);
if (!vendor || !inPath || !outPath) {
  console.error('usage: scrub-fixture.mjs <claude-code|codex> <in.jsonl> <out.jsonl>');
  process.exit(1);
}

const COMMIT_RE = /\bgit\b[^\n]*\bcommit\b/;
const FAKE_CMD = 'echo xxxxxxxx';
const FAKE_COMMIT_CMD = 'git add -A && git commit -m "xxx"';

// Replace text with x's, preserving length class (capped) and any prefix that
// parsers branch on (claude-code skips '<'/'Caveat:' texts and reads
// <command-name> tags for slash-command detection).
function redactText(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const m = s.match(/^<command-name>([^<]*)<\/command-name>/);
  if (m) return `<command-name>${m[1]}</command-name> ${'x'.repeat(8)}`;
  let prefix = '';
  if (s.startsWith('Caveat:')) prefix = 'Caveat: ';
  else if (s.startsWith('<')) prefix = '<system>';
  return prefix + 'x'.repeat(Math.max(1, Math.min(s.length, 64)));
}

function scrubCodexArguments(args) {
  // function_call.arguments is a JSON-encoded string like {"cmd": "..."}
  try {
    const parsed = JSON.parse(args);
    const cmd = typeof parsed.cmd === 'string' ? parsed.cmd : typeof parsed.command === 'string' ? parsed.command : null;
    const isCommit = cmd !== null && COMMIT_RE.test(cmd);
    return JSON.stringify({ cmd: isCommit ? FAKE_COMMIT_CMD : FAKE_CMD });
  } catch {
    return JSON.stringify({ cmd: FAKE_CMD });
  }
}

function scrubClaudeToolUse(block) {
  const input = block.input ?? {};
  const cmd = typeof input.command === 'string' ? input.command : null;
  const isCommit = block.name === 'Bash' && cmd !== null && COMMIT_RE.test(cmd);
  return {
    ...block,
    input: block.name === 'Bash' ? { command: isCommit ? FAKE_COMMIT_CMD : FAKE_CMD } : {},
  };
}

const TEXT_KEYS = new Set([
  'text', 'message', 'output', 'summary', 'instructions', 'user_instructions',
  'aggregated_output', 'formatted_output', 'description', 'reasoning',
  'firstPrompt', 'lastAssistantText', 'thinking', 'data', 'last_agent_message',
  'stdout', 'stderr', 'unified_diff', 'auto_compact_summary',
  'developer_instructions', 'input', // string-valued only: custom_tool_call patches etc.
]);
const PATH_KEYS = new Set(['cwd', 'workdir', 'path', 'projectPath']);

function walk(value, key, ctx) {
  if (Array.isArray(value)) return value.map((v) => walk(v, key, ctx));
  if (value !== null && typeof value === 'object') {
    if (ctx.vendor === 'claude-code' && value.type === 'tool_use') {
      return scrubClaudeToolUse({ ...value, input: value.input });
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (ctx.vendor === 'codex' && k === 'arguments' && typeof v === 'string') {
        out[k] = scrubCodexArguments(v);
      } else if (k === 'base_instructions') {
        out[k] = typeof v === 'string' ? redactText(v) : { text: 'xxxx' };
      } else if (PATH_KEYS.has(k) && typeof v === 'string') {
        out[k] = '/home/user/project';
      } else if ((k === 'gitBranch' || k === 'branch') && typeof v === 'string') {
        out[k] = 'main';
      } else if (k === 'repository_url' && typeof v === 'string') {
        out[k] = 'https://example.com/repo.git';
      } else if (k === 'commit_hash' && typeof v === 'string') {
        out[k] = '0'.repeat(v.length);
      } else if (k === 'encrypted_content' && typeof v === 'string') {
        out[k] = 'xxxx';
      } else if (k === 'command' && Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        out[k] = COMMIT_RE.test(v.join(' ')) ? ['git', 'commit', '-m', 'xxx'] : ['echo', 'xxxxxxxx'];
      } else if (k === 'parsed_cmd') {
        out[k] = [];
      } else if (k === 'changes' && v !== null && typeof v === 'object') {
        out[k] = {}; // patch change-sets are keyed by absolute file paths
      } else {
        out[k] = walk(v, k, ctx);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    if (value.startsWith('data:image')) return 'data:image/png;base64,xxxx';
    if (TEXT_KEYS.has(key)) return redactText(value);
  }
  return value;
}

const lines = fs.readFileSync(inPath, 'utf8').split('\n');
const out = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    out.push(line); // keep garbage lines as-is: they're drift-tolerance signal
    continue;
  }
  out.push(JSON.stringify(walk(e, '', { vendor })));
}
fs.writeFileSync(outPath, out.join('\n') + '\n');
console.log(`scrubbed ${out.length} lines -> ${outPath}`);
