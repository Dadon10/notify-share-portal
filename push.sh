#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not a git repository."
  exit 1
fi

if [ "$#" -gt 0 ]; then
  COMMIT_MESSAGE="$*"
else
  read -r -p "Commit message: " COMMIT_MESSAGE
fi

if [ -z "$COMMIT_MESSAGE" ]; then
  COMMIT_MESSAGE="chore: update project"
fi

printf '\n%s\n' "Reviewing current changes..."
git status --short

printf '\n%s\n' "Staging all changes..."
git add -A

printf '\n%s\n' "Committing with message: $COMMIT_MESSAGE"
git commit -m "$COMMIT_MESSAGE" || {
  echo "Nothing to commit."
  exit 0
}

REMOTE_NAME="${PUSH_REMOTE:-origin}"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)"

printf '\n%s\n' "Pushing $BRANCH_NAME to $REMOTE_NAME..."
git push -u "$REMOTE_NAME" "$BRANCH_NAME"

printf '\n%s\n' "Done."
