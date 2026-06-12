#!/usr/bin/env bash
# Compiles the two modules under test into tests/build/ and runs the unit tests.
# Usage: bash tests/run-tests.sh   (works from any cwd; exits nonzero on failure)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/proxy/node_modules/.bin/tsc" -p "$ROOT/tests/tsconfig.json"

node --test "$ROOT/tests/unit-context.mjs" "$ROOT/tests/unit-agentclient.mjs"
