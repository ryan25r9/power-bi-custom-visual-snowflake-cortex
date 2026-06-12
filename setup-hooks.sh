#!/usr/bin/env bash
#
# setup-hooks.sh — activate this repo's tracked git hooks. Run once per clone.
#
# Points git at .githooks/ (which is version-controlled) instead of the
# untracked .git/hooks/. Enables the post-commit auto-push safety net.

set -e
cd "$(dirname "$0")"

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

echo "✓ core.hooksPath -> .githooks"
echo "✓ post-commit auto-push is now active on this clone"
