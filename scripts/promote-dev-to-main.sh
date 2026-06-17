#!/usr/bin/env bash
# Promote the working branch (dev) to main — the SANCTIONED path.
#
# Why this exists: GitHub's "Squash and merge" button re-authors the resulting
# commit to whoever clicks it (the merging account), which would re-introduce
# personal identity onto a PUBLIC repo's history. Instead we advance main by
# moving the ref directly via the GitHub ref API to a commit that is ALREADY on
# origin and was authored locally under the approved org identity. The pointer
# move re-authors nothing.
#
# Two modes:
#   (default)            fast-forward: origin/main -> origin/dev. Use when dev's
#                        commits are already clean and atomic (the normal case).
#                        Lossless; preserves the conventional commit history.
#   --squash "message"   collapse all of origin/main..origin/dev into ONE commit
#                        authored by the org identity, then point main at it.
#                        Use when dev accumulated messy WIP commits.
#
# Either way: the working tree must be clean, dev must be pushed, and EVERY
# commit being promoted is audited against .claude/factory/identity-policy.json
# (approved author/committer, no denylisted PII) before main moves. Aborts loud.
#
# Usage:
#   scripts/promote-dev-to-main.sh                 # fast-forward
#   scripts/promote-dev-to-main.sh --squash "chore(release): 0.3.0"
set -euo pipefail

REPO_SLUG="axomiqlabs/codenomics"
WORK_BRANCH="dev"
PROTECTED="main"
ROOT="$(git rev-parse --show-toplevel)"
POLICY="$ROOT/.claude/factory/identity-policy.json"
cd "$ROOT"

die() { echo "ABORT: $*" >&2; exit 1; }
note() { echo "==> $*"; }

# --- parse args -------------------------------------------------------------
MODE=ff
SQUASH_MSG=""
if [ "${1:-}" = "--squash" ]; then
  MODE=squash
  SQUASH_MSG="${2:-}"
  [ -n "$SQUASH_MSG" ] || die "--squash requires a commit message"
fi

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

note "fetching origin"
git fetch origin --quiet

LOCAL_DEV="$(git rev-parse "$WORK_BRANCH")"
REMOTE_DEV="$(git rev-parse "origin/$WORK_BRANCH")"
[ "$LOCAL_DEV" = "$REMOTE_DEV" ] || die "local $WORK_BRANCH != origin/$WORK_BRANCH — push dev first"

REMOTE_MAIN="$(git rev-parse "origin/$PROTECTED")"
if [ "$REMOTE_MAIN" = "$REMOTE_DEV" ]; then
  note "origin/$PROTECTED already at origin/$WORK_BRANCH ($(git rev-parse --short "$REMOTE_DEV")) — nothing to promote"
  exit 0
fi

# main must be a strict ancestor of dev (no divergence) for either mode to be safe.
git merge-base --is-ancestor "origin/$PROTECTED" "origin/$WORK_BRANCH" \
  || die "origin/$PROTECTED is not an ancestor of origin/$WORK_BRANCH — histories diverged; reconcile manually"

RANGE="origin/$PROTECTED..origin/$WORK_BRANCH"
note "commits to promote:"
git --no-pager log --oneline "$RANGE"

# --- identity audit: every promoted commit, author AND committer -------------
note "auditing author/committer identity on all promoted commits"
AUDIT_FAIL=0
while IFS=$'\t' read -r sha ae ce an cn; do
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
done < <(git --no-pager log --format='%H%x09%ae%x09%ce%x09%an%x09%cn' "$RANGE")
[ "$AUDIT_FAIL" = 0 ] || die "identity audit failed — refusing to promote PII to public main"
note "identity audit clean ✓"

# --- compute the target sha main will point at ------------------------------
if [ "$MODE" = ff ]; then
  TARGET="$REMOTE_DEV"
  note "fast-forward: $PROTECTED -> $(git rev-parse --short "$TARGET")"
else
  # Build a single squashed commit on top of origin/main, authored by the org
  # identity, with the dev tree. Push to a temp ref so the ref-API can target it.
  note "squash: collapsing $RANGE into one commit"
  TREE="$(git rev-parse "origin/$WORK_BRANCH^{tree}")"
  TARGET="$(GIT_AUTHOR_NAME="$APPROVED_NAME" GIT_AUTHOR_EMAIL="$APPROVED_EMAIL" \
            GIT_COMMITTER_NAME="$APPROVED_NAME" GIT_COMMITTER_EMAIL="$APPROVED_EMAIL" \
            git commit-tree "$TREE" -p "$REMOTE_MAIN" -m "$SQUASH_MSG")"
  note "created squash commit $(git rev-parse --short "$TARGET"); pushing to temp ref"
  git push origin "$TARGET:refs/heads/_promote-tmp" --quiet
fi

# --- advance main via the ref API (no re-authoring) --------------------------
note "advancing origin/$PROTECTED via ref API"
gh api -X PATCH "repos/$REPO_SLUG/git/refs/heads/$PROTECTED" \
  -f sha="$TARGET" -F force=false >/dev/null \
  || die "ref-API update failed (is it a fast-forward? use --squash if histories differ)"

# clean up temp ref if we made one
if [ "$MODE" = squash ]; then
  git push origin ":refs/heads/_promote-tmp" --quiet || true
fi

# --- sync local refs --------------------------------------------------------
git fetch origin --quiet
git branch -f "$PROTECTED" "origin/$PROTECTED"
if [ "$MODE" = squash ]; then
  note "squash promoted. Reset $WORK_BRANCH onto the new main so they don't diverge:"
  note "  git checkout $WORK_BRANCH && git reset --hard origin/$PROTECTED && git push -f origin $WORK_BRANCH"
fi

NEW_MAIN="$(gh api "repos/$REPO_SLUG/git/refs/heads/$PROTECTED" --jq '.object.sha')"
note "done. origin/$PROTECTED is now $(git rev-parse --short "$NEW_MAIN")"
note "verify authorship: gh api repos/$REPO_SLUG/commits/$PROTECTED --jq '.commit.author'"
