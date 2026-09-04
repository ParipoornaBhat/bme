#!/usr/bin/env bash
set -e

# scripts/git-sync.sh
# Safely pulls updates from origin/main, fast-forwarding or merging with conventional commit standards.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "[git-sync] Not on main branch (on $BRANCH). Skipping sync."
  exit 0
fi

echo "[git-sync] Fetching origin main..."
git fetch origin main --quiet

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
BASE="$(git merge-base HEAD origin/main)"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[git-sync] Up to date with origin/main ($LOCAL)"
  exit 0
elif [ "$LOCAL" = "$BASE" ]; then
  echo "[git-sync] Fast-forwarding to origin/main..."
  git merge --ff-only origin/main
  echo "[git-sync] Fast-forward complete."
else
  echo "[git-sync] Branches diverged. Merging origin/main..."
  if git merge origin/main --no-edit -m "Merge remote-tracking branch 'origin/main'"; then
    echo "[git-sync] Clean merge completed."
  else
    echo "[git-sync] Merge conflict detected!"
    git status --short
    exit 1
  fi
fi
