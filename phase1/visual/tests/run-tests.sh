#!/usr/bin/env bash
# Compiles the Phase 1 contextBuilder into tests/build/ and runs its unit tests.
# Usage: bash phase1/visual/tests/run-tests.sh   (works from any cwd)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # = phase1/visual

"$ROOT/node_modules/.bin/tsc" -p "$ROOT/tests/tsconfig.json"

node --test "$ROOT/tests/unit-context.mjs" "$ROOT/tests/unit-capabilities.mjs"
