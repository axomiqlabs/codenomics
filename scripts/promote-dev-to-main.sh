#!/usr/bin/env bash
# Promote dev -> public main. The ONLY path that puts code in the public repo.
#
# Model: dev lives on a PRIVATE remote (the `private` remote; URL in .git/config);
# all WIP pushes go there and stay private. The PUBLIC repo (axomiqlabs/codenomics)
# only ever
# receives one clean, squashed commit per release on main — the messy WIP history
# never becomes public. This script:
#
#   1. audits dev's commits for the approved org identity (no personal PII),
#   2. squashes dev's CURRENT TREE into one commit (parent = public main,
#      authored by the org identity),
#   3. advances public main to it via the GitHub ref API (a pointer move, so
#      nothing is re-authored — GitHub's merge/squash buttons would re-stamp the
#      merging account, which is why we never use them),
#   4. resets dev onto the released baseline and force-pushes it PRIVATE, so the
#      next release's diff is just the net new changes.
#
# Usage:
#   scripts/promote-dev-to-main.sh "chore(release): 0.3.0"
set -euo pipefail

PUBLIC_REMOTE="origin"                 # axomiqlabs/codenomics (public)
PRIVATE_REMOTE="private"               # private dev mirror (URL in .git/config)
REPO_SLUG="axomiqlabs/codenomics"
WORK_BRANCH="dev"
PROTECTED="main"
ROOT="$(git rev-parse --show-toplevel)"
POLICY="$ROOT/.claude/factory/identity-policy.json"
cd "$ROOT"

die() { echo "ABORT: $*" >&2; exit 1; }
note() { echo "==> $*"; }

MSG="${1:-}"
[ -n "$MSG" ] || die "a release commit message is required, e.g.: $0 \"chore(release): 0.3.0\""

# --- preflight --------------------------------------------------------------
command -v gh >/dev/null || die "gh CLI not found"
command -v jq >/dev/null || die "jq not found"
[ -f "$POLICY" ] || die "identity policy not found: $POLICY"

APPROVED_EMAIL="$(jq -r '.approvedEmail' "$POLICY")"
APPROVED_NAME="$(jq -r '.approvedName' "$POLICY")"
mapfile -t DENY < <(jq -r '.deny[]' "$POLICY")

[ -z "$(git status --porcelain)" ] || die "working tree not clean — commit or stash first"
CUR="$(git rev-parse --abbrev-ref HEAD)"
[ "$CUR" = "$WORK_BRANCH" ] || die "not on '$WORK_BRANCH' (on '$CUR')"

note "fetching $PRIVATE_REMOTE + $PUBLIC_REMOTE"
git fetch "$PRIVATE_REMOTE" --quiet
git fetch "$PUBLIC_REMOTE" --quiet

# dev must be pushed to the private remote (that's the backed-up source of truth).
LOCAL_DEV="$(git rev-parse "$WORK_BRANCH")"
PRIV_DEV="$(git rev-parse "$PRIVATE_REMOTE/$WORK_BRANCH")"
[ "$LOCAL_DEV" = "$PRIV_DEV" ] || die "local $WORK_BRANCH != $PRIVATE_REMOTE/$WORK_BRANCH — push dev to private first (git push $PRIVATE_REMOTE $WORK_BRANCH)"

PUB_MAIN="$(git rev-parse "$PUBLIC_REMOTE/$PROTECTED")"
DEV_TREE="$(git rev-parse "$WORK_BRANCH^{tree}")"
MAIN_TREE="$(git rev-parse "$PUBLIC_REMOTE/$PROTECTED^{tree}")"
if [ "$DEV_TREE" = "$MAIN_TREE" ]; then
  note "dev tree already matches public main — nothing to release"
  exit 0
fi

# --- show what will become public + audit identity --------------------------
note "net changes this release (public main -> dev):"
git --no-pager diff --stat "$PUBLIC_REMOTE/$PROTECTED" "$WORK_BRANCH" | tail -40

note "auditing author/committer identity on dev's commits since public main"
AUDIT_FAIL=0
while IFS=$'\t' read -r sha ae ce an cn; do
  [ -z "$sha" ] && continue
  for who in "$ae|author-email" "$ce|committer-email"; do
    val="${who%%|*}"; label="${who##*|}"
    if [ "$(printf '%s' "$val" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$APPROVED_EMAIL" | tr '[:upper:]' '[:lower:]')" ]; then
      echo "  ✗ $sha $label '$val' != approved '$APPROVED_EMAIL'"; AUDIT_FAIL=1
    fi
  done
  for field in "$an|author-name" "$cn|committer-name" "$ae|author-email" "$ce|committer-email"; do
    val="${field%%|*}"; label="${field##*|}"
    for pat in "${DENY[@]}"; do
      if printf '%s' "$val" | grep -qiE "$pat"; then
        echo "  ✗ $sha $label '$val' matches denylist /$pat/"; AUDIT_FAIL=1
      fi
    done
  done
done < <(git --no-pager log --format='%H%x09%ae%x09%ce%x09%an%x09%cn' "$PUBLIC_REMOTE/$PROTECTED..$WORK_BRANCH")
[ "$AUDIT_FAIL" = 0 ] || die "identity audit failed — refusing to promote PII to public main"
note "identity audit clean ✓"

# --- build the squashed release commit (org-authored) -----------------------
note "creating squashed release commit (tree=dev, parent=public main)"
TARGET="$(GIT_AUTHOR_NAME="$APPROVED_NAME" GIT_AUTHOR_EMAIL="$APPROVED_EMAIL" \
          GIT_COMMITTER_NAME="$APPROVED_NAME" GIT_COMMITTER_EMAIL="$APPROVED_EMAIL" \
          git commit-tree "$DEV_TREE" -p "$PUB_MAIN" -m "$MSG")"
note "release commit $(git rev-parse --short "$TARGET"); pushing to public temp ref"
git push "$PUBLIC_REMOTE" "$TARGET:refs/heads/_promote-tmp" --quiet

# --- advance public main via the ref API (no re-authoring) -------------------
note "advancing $PUBLIC_REMOTE/$PROTECTED via ref API"
gh api -X PATCH "repos/$REPO_SLUG/git/refs/heads/$PROTECTED" \
  -f sha="$TARGET" -F force=false >/dev/null \
  || die "ref-API update failed (not a fast-forward — public main has commits dev lacks; reconcile manually)"
git push "$PUBLIC_REMOTE" ":refs/heads/_promote-tmp" --quiet || true

# --- reset dev onto the released baseline, keep it PRIVATE -------------------
git fetch "$PUBLIC_REMOTE" --quiet
git branch -f "$PROTECTED" "$PUBLIC_REMOTE/$PROTECTED"
note "resetting $WORK_BRANCH onto the released baseline (tree unchanged) and force-pushing PRIVATE"
git reset --hard "$PUBLIC_REMOTE/$PROTECTED" --quiet
git push -f "$PRIVATE_REMOTE" "$WORK_BRANCH" --quiet

NEW_MAIN="$(gh api "repos/$REPO_SLUG/git/refs/heads/$PROTECTED" --jq '.object.sha')"
note "done. public $PROTECTED -> $(git rev-parse --short "$NEW_MAIN")  ($MSG)"
note "verify authorship: gh api repos/$REPO_SLUG/commits/$PROTECTED --jq '.commit.author'"
note "note: dev:4848 tree is unchanged; no rebuild needed."
