#!/usr/bin/env bash
#
# setup-hooks.sh — activate this repo's tracked git hooks. Run once per clone.
#
# Points git at .githooks/ (which is version-controlled) instead of the
# untracked .git/hooks/. Enables the post-commit feature-branch auto-push
# (it pushes the branch you're on, never the shared main).
#
# Optional and machine-local: a developer using a plain IDE does NOT need to run
# this — stock git works fine for the branch -> PR flow in CONTRIBUTING.md.

set -e
cd "$(dirname "$0")"

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

echo "✓ core.hooksPath -> .githooks"
echo "✓ post-commit feature-branch auto-push is active on this clone (never pushes main)"
