# Privacy

Codenomics is **local-first by design**. The collectors read agent transcripts
and telemetry that already exist on your machine; everything they derive stays
on your machine.

## What the local tool stores (in `~/.local/share/codenomics/`)

- `index.json` — per-session metrics: token counts per model, prompt/turn/tool/
  commit counts, timestamps, project keys (derived from working directories),
  plus two short text excerpts per session (the opening prompt and final
  assistant message, used for the dashboard recap column).
- `summaries.json` — optional AI-generated one-line recaps (created only when
  you run `codenomics summarize`, via your own `claude` CLI).
- `reports/` — the report artifacts you generate.

Nothing is transmitted anywhere by any current command.

## The dashboard

`codenomics serve` binds to `127.0.0.1` by default. Binding to any other host
prints a warning, because the dashboard exposes the data above to whoever can
reach the port.

## The future cloud sync (not yet available)

`codenomics sync` today is a **preview stub** — it prints what a sync would
send and exits. The payload contract is `RollupV1` (see `src/core/schema.ts`):
daily aggregates of token counts, session/prompt/commit counts, and active
time per (day, vendor, model, project, human/machine).

Hard commitments for when sync ships:

1. **Aggregates only.** Prompts, code, transcripts, tool output, file paths,
   and text excerpts never leave the machine. The sync payload type has no
   text-bearing fields, enforced by schema and tests.
2. **Project keys are the only potentially identifying strings.** Sync will
   offer aliasing/hashing of project keys before anything is sent.
3. **Opt-in, inspectable, versioned.** `sync --json` always shows the exact
   payload; schema changes bump `schemaVersion`.

## The cross-org benchmark (Team, not yet available)

The Team plane's benchmark — "is your true $/commit good, vs the field?" — is
built entirely from the opt-in `RollupV1` aggregates above. It is the only
feature that uses off-machine data, so it carries its own hard commitments:

1. **Aggregates only, same payload.** The benchmark consumes nothing the sync
   contract doesn't already cover — no prompts, code, transcripts, tool output,
   file paths, or text excerpts. There is no second, richer upload path.
2. **k-anonymity, k ≥ 5.** No benchmark cell is computed or shown unless at
   least **5 distinct contributing orgs** fall in it — a hard floor we never go
   below. In practice the published gate is set higher (currently **8**), as
   headroom against anyone manufacturing orgs to collapse a cohort; an org also
   only counts once it has a minimum contribution history. Cohorts below the
   threshold are withheld, never estimated or back-filled.
3. **Structural ratios, not your drivers.** Benchmarking runs on portable
   compute-and-outcome metrics (prompts-per-commit, cache-hit share,
   tokens-per-commit, model mix). Your `attentionUsdPerPrompt` and
   `engHourlyRateUsd` stay local and are never part of the cohort math.
4. **Percentiles, never rows.** Benchmark output is a percentile over a
   population — never another org's underlying row.
5. **Project labels hashable before they leave.** As with sync, the one
   potentially identifying string can be aliased/hashed on the machine first.
6. **Contributing is separable from using.** The local tool is fully useful
   with zero sync. You opt in to contribute aggregates in exchange for seeing
   where you stand; you can use Team without contributing.
7. **Honest sample size.** Every comparison shows the *n* behind it; no figure
   is presented as a market norm before the cohort can support the claim.

## Fixtures in this repository

Test fixtures under `test/fixtures/` are derived from real transcripts passed
through `scripts/scrub-fixture.mjs`, which replaces all text content (prompts,
outputs, diffs, paths, signatures, even base64 images) with placeholder bytes
while preserving structure. An automated audit asserts no string longer than
40 characters survives scrubbing except known-safe structural values.
