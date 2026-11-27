#!/usr/bin/env bash
# Promote a "Release X.Y.Z" commit: fast-forward main to it and tag it vX.Y.Z.
# Usage: scripts/promote-release.sh <commit-sha> [remote] [--dry-run]
set -euo pipefail

sha="${1:?usage: promote-release.sh <commit-sha> [remote] [--dry-run]}"
remote="${2:-origin}"
dry_run=false
[[ "${3:-}" == "--dry-run" || "${2:-}" == "--dry-run" ]] && dry_run=true
[[ "$remote" == "--dry-run" ]] && remote=origin

fail() { echo "promote-release: $*" >&2; exit 1; }

subject="$(git log -1 --format=%s "$sha")"
[[ "$subject" =~ ^Release\ ([0-9]+\.[0-9]+\.[0-9]+)$ ]] || fail "commit $sha is not a 'Release X.Y.Z' commit (subject: '$subject')"
version="${BASH_REMATCH[1]}"
tag="v$version"

git fetch --quiet "$remote" main --tags
if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  fail "tag $tag already exists"
fi
git merge-base --is-ancestor "$remote/main" "$sha" || fail "main is not an ancestor of $sha; refusing a non-fast-forward release"

worktree="$(mktemp -d)"
trap 'git worktree remove --force "$worktree" >/dev/null 2>&1 || true' EXIT
git worktree add --quiet --detach "$worktree" "$sha"
python3 "$worktree/scripts/check-release.py" "$tag" || fail "check-release.py refused $tag"

if $dry_run; then
  echo "dry run: would push $sha to $remote main and tag $tag"
  exit 0
fi

git push "$remote" "$sha:refs/heads/main"
git push "$remote" "$sha:refs/tags/$tag"
echo "Released $tag at $sha"
