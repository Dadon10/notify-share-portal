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

REMOTE_NAME="${PUSH_REMOTE:-${GIT_PUSH_REMOTE:-}}"

if [ -n "$REMOTE_NAME" ]; then
  printf '\n%s\n' "Pushing to remote: $REMOTE_NAME"
  git push "$REMOTE_NAME" HEAD
else
  printf '\n%s\n' "Changes are committed locally."
  printf '%s\n' "To push to the connected Lovable app, configure a non-GitHub remote and run:"
  printf '%s\n' "  export PUSH_REMOTE=lovable"
  printf '%s\n' "  ./push.sh \"your commit message\""
  printf '%s\n' "or: git remote set-url <remote-name> <lovable-repository-url>"
fi

printf '\n%s\n' "Done."
