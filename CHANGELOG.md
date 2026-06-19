# Changelog

All notable changes to **codenomics** are recorded here. The project follows
[Semantic Versioning](https://semver.org); the format follows
[Keep a Changelog](https://keepachangelog.com).

Releases ship to the public `main` branch as a single squashed commit per the
promotion flow (see `CLAUDE.md`), so this file — not the public git history — is
the human-readable record of what changed in each published version.

## [0.3.0] — 2026-06-18

- Marketing blog launched, leading with the "the cheapest model was the most
  expensive" benchmark post.
- Passive npm update notifier: TTY-only, polled at most once daily, opt-out via
  `CODENOMICS_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` / `CI`.
- Install modal on the marketing site.
- Privacy hardening: per-install salted-SHA-256 project hashing, with a
  `ProjectHash` branded type making it a compile-time error to put a raw project
  string on the wire.

## [0.2.6] — 2026-06-18

- Marketing v2: product tour plus dashboard illustrations (trading desk, model
  leaderboard, agent P&L, box score, daily-burn heatmap, cost waterfall).

## [0.2.5] — 2026-06-17

- Opt-in 12-hour auto-sync: benchmark join, cross-OS scheduler, and sync-on-serve.

## [0.2.4] — 2026-06-17

- Model B release flow (marketing ships via `main`), dev badges, branded waitlist.

## [0.2.3] — 2026-06-17

- `npx` onboarding hints; private-dev release workflow.

## [0.2.2] — 2026-06-16

- Benchmark endpoint moved to `api.codenomics.ai`.

## [0.2.1] — 2026-06-16

- Self-serve benchmark join flow; plain-language onboarding.

## [0.2.0] — 2026-06-16

- Cloud sync and the "How you compare" benchmark panel.
