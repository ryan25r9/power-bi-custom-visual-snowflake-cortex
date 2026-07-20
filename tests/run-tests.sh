#!/usr/bin/env bash
# Compiles the modules under test (visual -> tests/build/, proxy auth ->
# tests/build-proxy/) and runs the unit tests.
# Usage: bash tests/run-tests.sh   (works from any cwd; exits nonzero on failure)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT/proxy/node_modules/.bin/tsc" -p "$ROOT/tests/tsconfig.json"
"$ROOT/proxy/node_modules/.bin/tsc" -p "$ROOT/tests/tsconfig.proxy.json"

# The compiled ESM auth module does `import ... from "jose"`. Bare specifiers
# resolve by walking parent node_modules (NODE_PATH is CJS-only), and jose is
# installed under proxy/ — so link it into tests/node_modules for the run.
mkdir -p "$ROOT/tests/node_modules"
ln -sfn "$ROOT/proxy/node_modules/jose" "$ROOT/tests/node_modules/jose"

node --test "$ROOT/tests/unit-context.mjs" "$ROOT/tests/unit-agentclient.mjs" \
            "$ROOT/tests/unit-richtext.mjs" "$ROOT/tests/unit-proxyauth.mjs" \
            "$ROOT/tests/unit-profiles.mjs"
