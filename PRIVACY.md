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

## Fixtures in this repository

Test fixtures under `test/fixtures/` are derived from real transcripts passed
through `scripts/scrub-fixture.mjs`, which replaces all text content (prompts,
outputs, diffs, paths, signatures, even base64 images) with placeholder bytes
while preserving structure. An automated audit asserts no string longer than
40 characters survives scrubbing except known-safe structural values.
