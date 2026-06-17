# Working in this repository

`codenomics` is a **public** package (FSL-1.1-MIT). Two rules dominate everything
else here: history stays free of personal identity, and `main` only ever moves
through the sanctioned promotion path. Both are enforced by hooks — the notes
below explain the *why* so you work with them, not around them.

## Branch model

- **`dev`** — the single long-lived working branch. All commits land here. Push
  it freely (`git push origin dev`).
- **`main`** — release branch. It is **never** updated by a local push or by
  GitHub's merge/squash button. It advances only via the promotion script.

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

## Releasing: dev → main

**Never click "Squash and merge" / "Merge" on GitHub, and never `git push origin
main`.** GitHub's merge buttons re-author the resulting commit to the *merging
account*, which re-introduces personal identity onto public history (`git push
origin main` is hard-blocked by `deny-push-to-main.js` for the same reason).

Promote with the script instead — it audits every promoted commit's author *and*
committer against the identity policy, then advances `main` by moving the ref via
the GitHub API (a pointer move re-authors nothing):

```sh
scripts/promote-dev-to-main.sh                      # fast-forward (normal case)
scripts/promote-dev-to-main.sh --squash "chore(release): 0.3.0"   # collapse messy WIP
```

Default fast-forward when `dev`'s commits are already clean and atomic. Use
`--squash` only when `dev` accumulated noisy WIP commits.

## Hooks (`.claude/hooks/`, wired in `.claude/settings.json`)

- `pre-commit-identity-guard.js` — blocks PII / wrong-identity commits.
- `pre-commit-gate.js` — secret scan + commit-message format.
- `deny-push-to-main.js` — blocks pushes to protected branches (`.claude/factory/protected-branch`).
- `deny-destructive-git.js` — blocks force-push / history rewrites that could reach `main`.
- `block-uncommitted-on-stop.js` — flags uncommitted work when a session ends.

## Local serving

- `:3838` — the maintainer's **personal** dashboard (`codenomics-dashboard.service`). Leave it alone.
- `:3939` — the private control surface (separate repo). Leave it alone.

## Build / check

```sh
npm run typecheck
npm test          # build + node --test
npm run build
```
