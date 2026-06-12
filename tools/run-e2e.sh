#!/usr/bin/env bash
# End-to-end proof of the SSE relay: compile, start mock Snowflake, run tests, tear down.
# Usage: bash tools/run-e2e.sh   (from anywhere; paths resolved relative to this script)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== compiling proxy =="
(cd "$ROOT/proxy" && ./node_modules/.bin/tsc) || { echo "tsc failed"; exit 1; }

echo "== starting mock snowflake + running tests =="
node "$ROOT/tools/mock-snowflake.mjs" &
SRV=$!
sleep 0.5
node "$ROOT/tools/test-proxy.mjs"
RC=$?

kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null

exit $RC
