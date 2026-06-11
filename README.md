# Codenomics

**Decode the true economics of your AI coding agents.**

Every token dashboard tells you what you burned. Codenomics tells you what you
*got* — the true cost of each shipped change, across Claude Code, Codex CLI,
and Gemini CLI, computed entirely on your machine.

```
TRUE $/COMMIT = (compute $ + prompts × attention $ + active time × hourly $) / commits
```

A model that burns more tokens but needs fewer corrections and less
babysitting *wins* on this number. That's the comparison that actually matters
when you pick a model or an agent — and no token counter shows it.

## Quick start

```bash
npx codenomics init     # detect agents, write config
npx codenomics index    # scan local agent logs (incremental, seconds)
npx codenomics serve    # dashboard at http://127.0.0.1:3737
```

No account. No upload. Zero runtime dependencies. Your transcripts never leave
your machine ([PRIVACY.md](PRIVACY.md)).

## What you get

- **Local dashboard** — true $/commit, API-equivalent burn, model-vs-model
  economics, daily burn chart, per-session drill-down with cache and
  context-bloat diagnostics, human vs machine (headless/CI) split.
- **Multi-agent collectors** — Claude Code transcripts, Codex CLI rollouts
  (per-turn token accounting validated against cumulative totals), Gemini CLI
  OTEL telemetry (best-effort; requires telemetry enabled).
- **Economic drivers you control** — what's a prompt of your attention worth?
  What's your loaded hourly rate? Set them in config or the dashboard; every
  metric updates instantly. Per-model pricing overrides included.
- **Budgets** — $ or token limits per day/week/month, globally or per
  project/agent. `codenomics index --check-budgets` exits nonzero on breach,
  so cron alerting is one line.
- **Canned reports** — `codenomics report weekly|monthly` renders Markdown +
  self-contained HTML with prior-period deltas, top sessions, budget status,
  and rule-based observations (e.g. "your headless jobs ran on a premium
  model; same tokens at haiku pricing = $X saved"). Optional Slack digest via
  webhook. `codenomics report schedule --install-cron` automates it.
- **AI recaps** (optional) — one-line session summaries via your own `claude`
  CLI, cached forever.

## Commands

| command | what it does |
|---|---|
| `init` | detect agents, write user config; `--from <dir>` imports old claude-stats recaps |
| `index` | incremental scan of agent logs; `--check-budgets` for cron |
| `serve` | local dashboard (127.0.0.1 only by default) |
| `report weekly\|monthly` | md/html artifacts; `--slack` posts a digest; `schedule` for cron |
| `config get\|set\|unset\|list\|path` | dotted-path config editing |
| `summarize` | AI recaps for recent sessions |
| `doctor` | collector status, quarantined files, format-drift stats |
| `sync` | preview of the future (opt-in, aggregates-only) team sync |

## Configuration

`~/.config/codenomics/config.json` (user) and `.codenomics.json` (per-project),
merged with flags > env > project > user > defaults:

```json
{
  "drivers": { "attentionUsdPerPrompt": 5, "engHourlyRateUsd": 0 },
  "pricing": { "gpt-5.5": { "in": 1.25, "out": 10 } },
  "limits": [
    { "id": "daily-burn", "metric": "costUsd", "period": "day", "max": 50, "scope": "global" }
  ],
  "report": { "slackWebhookUrl": null },
  "server": { "port": 3737, "host": "127.0.0.1" }
}
```

**$ figures are API-equivalent compute cost** (cache-aware: read/write rates
modeled per vendor). On a subscription plan your marginal $ is 0 — read them
as a normalized compute meter that makes models and agents comparable.
Built-in pricing drifts as vendors change it; override any model in config.

## How it reads your data

| agent | source | notes |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | full fidelity: cache 5m/1h split, commits, human/machine, prompts |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | per-turn tokens incl. reasoning; commits; subagent detection |
| Gemini CLI | `~/.gemini` OTEL telemetry | requires telemetry enabled; no commit/source signals (shown as —) |

These are undocumented, fast-moving formats. Parsers are tolerant by design:
malformed lines are skipped, unknown event types are counted (`doctor` shows
drift), and a file that fails to parse is quarantined without killing the run.

## Development

```bash
npm install
npm test        # tsc build + node:test (fixtures are scrubbed real transcripts)
```

Licensed [FSL-1.1-MIT](LICENSE) (Functional Source License): use it, read it,
modify it, self-host it for anything except offering a competing product —
and every release becomes plain MIT two years after it ships.

Contributions welcome — especially fixtures from agent versions we haven't
seen. `scripts/scrub-fixture.mjs` redacts a transcript so you can share its
*shape* without sharing its content.
