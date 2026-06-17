# Working in this repository

`codenomics` is a **public** package (FSL-1.1-MIT). Two rules dominate everything
else here: history stays free of personal identity, and the **public repo only
ever receives squashed releases — never WIP**. Both are enforced by hooks — the
notes below explain the *why* so you work with them, not around them.

## Remotes & branch model

WIP develops privately; only clean releases go public.

- **`private`** → a private dev mirror (URL in `.git/config`). All dev/WIP pushes go here.
- **`origin`** → `axomiqlabs/codenomics` (PUBLIC). Receives squashed releases on
  `main` only. **Direct pushes to `origin` are hard-blocked** by `deny-push-to-main.js`.

Branches:

- **`dev`** — the single long-lived working branch; its upstream is `private/dev`.
  All commits land here; `git push` (or `git push private dev`) backs them up privately.
- **`main`** — public release branch. Never updated by a push or by GitHub's
  merge/squash button — only via the promotion script.

## Turn-completion ritual

When you finish a unit of work, complete the turn like this (mirrors the muscle
memory from other repos — commit, push, reload):

```sh
npm run build                                  # if app code changed
systemctl --user restart codenomics-dev        # refresh the :4848 preview
git add -A && git commit -m "type(scope): ..."  # identity-guarded
git push private dev                           # back up WIP privately (NOT origin)
```

`block-uncommitted-on-stop.js` will flag a session that ends with uncommitted work.

## Commit identity (enforced)

Commits must be authored as **`Axomiq Labs <hello@codenomics.ai>`**. The approved
identity and the personal-PII denylist live in
`.claude/factory/identity-policy.json`. `pre-commit-identity-guard.js` blocks any
commit whose `user.email` isn't the approved one, or whose message/diff contains
denylisted personal strings. If a commit is blocked on identity:

```sh
git config user.email 'hello@codenomics.ai'
git config user.name  'Axomiq Labs'
```

## Releasing: dev → public main

**Never click "Squash and merge" / "Merge" on GitHub, and never push to `origin`.**
GitHub's merge buttons re-author the resulting commit to the *merging account*,
re-introducing personal identity onto public history.

Release with the script — it audits dev's commits for the org identity, squashes
dev's **current tree** into one commit (authored by the org identity, parent =
public main), advances `main` via the GitHub ref API (a pointer move re-authors
nothing), then resets `dev` onto the released baseline and force-pushes it
**privately**. So the public repo gets exactly one clean commit per release and
the WIP history never appears there.

**The release ritual — main drives everything (Model B).** All three products ship
through `main`. The promote squashes dev's *entire current tree* into **one** commit
on `main` (N dev commits → 1 main commit — that's your batching, built in: just
promote less often), then:

```sh
# 1. dev tree -> one squashed commit on public main
scripts/promote-dev-to-main.sh "chore(release): 0.3.0"
# 2. refresh the stable worktree (updates BOTH :3838 app and site/ source)
git -C /srv/codenomics-stable pull && (cd /srv/codenomics-stable && npm run build)
# 3. publish the live surfaces from released main:
bash ~/codenomics-pages-deploy.sh          # marketing -> codenomics.ai
npm publish                                # app -> npm   (only when the package changed)
# cloud backend is its own repo/pipeline:  ~/codenomics-deploy.sh (api.codenomics.ai)
```

Run steps 1–2 every release; step 3 only for the surfaces that actually changed.

## Hooks (`.claude/hooks/`, wired in `.claude/settings.json`)

- `pre-commit-identity-guard.js` — blocks PII / wrong-identity commits.
- `pre-commit-gate.js` — secret scan + commit-message format.
- `deny-push-to-main.js` — blocks direct pushes to the public remote (`.claude/factory/public-remote`) and to protected branches (`.claude/factory/protected-branch`).
- `deny-destructive-git.js` — blocks force-push / history rewrites that could reach `main`.
- `block-uncommitted-on-stop.js` — flags uncommitted work when a session ends.

## Checkouts & local serving

This repo ships **two products**: the **app** (`src/`→`dist/`, the npm package) and
the **marketing site** (`site/`, static). One repo, one `dev` branch — `dist/` and
`site/` come from the same checkout. They differ only in *where they serve*.

Two worktrees keep the personal dashboard isolated from dev churn:

- `/srv/codenomics` — **dev** branch. The working checkout: Claude's hooks, settings,
  and memory are anchored here, so do all development here.
- `/srv/codenomics-stable` — **main** branch worktree. Feeds the personal dashboard.
  Refresh it after a promote: `git -C /srv/codenomics-stable pull && npm run build`.

App serving (systemd `--user` services):

- `:3838` — personal/stable app, from `/srv/codenomics-stable` (`codenomics-dashboard.service`). Real cost data. **Leave it alone.**
- `:4848` — **dev app preview**, from `/srv/codenomics` (`codenomics-dev.service`). Uses an isolated data/config dir (`~/.local/share/codenomics-dev`) so it can't touch personal data. Rebuild (`npm run build`) after committing to dev to refresh.
- `:3939` — the private control surface (separate repo). Leave it alone.

Marketing serving (Cloudflare Pages, project `codenomics`):

- **Model B — main drives everything.** Production `codenomics.ai` deploys from the
  **`main` branch via the stable worktree** (`/srv/codenomics-stable/site/`), never
  from raw `dev`. So the live site always reflects a *released* commit, exactly like
  the npm package and the `:3838` dashboard. `~/codenomics-pages-deploy.sh` enforces
  this: it `cd`s to `/srv/codenomics-stable`, **aborts if that tree isn't at
  `origin/main`** (so a stale deploy can't revert a not-yet-promoted fix), then
  uploads `site/`. To ship a marketing change: promote dev→main, refresh stable,
  then deploy (see Releasing).
- `*.pages.dev` exposure is contained: every page's `<head>` redirects any `*.pages.dev`
  host (the bare alias + all per-deploy hash URLs) to `codenomics.ai`, and `rel=canonical`
  points search at `codenomics.ai`. Prune old Pages deployments after each redeploy.
- Dev preview → `site/` is served LOCALLY at `http://127.0.0.1:4747` by the
  `codenomics-site-dev.service` user unit (a `python3 -m http.server` on loopback).
  Do NOT use a `pages.dev` preview deployment — the redirect above would bounce it
  to production. Localhost is unaffected (the redirect only fires on `pages.dev` hosts).

## Build / check

```sh
npm run typecheck
npm test          # build + node --test
npm run build
```
