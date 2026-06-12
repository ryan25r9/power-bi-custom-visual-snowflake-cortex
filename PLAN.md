# Build & Verification Log

Plan executed 2026-06-12. Decisions: shared-key auth (v1), Azure Functions hosting, rich rendering (tool activity + SQL audit + Vega-Lite charts), full rigor.

## What was built and HOW it was verified

| Component | Verification | Result |
|---|---|---|
| `visual/dist/*.pbiviz` (330 KB) | Packaged with powerbi-visuals-tools 6.2.0 / api 5.11.0; archive inspected; bundle probed at byte level for our code, vega, CSS, and both bug-fix patches | ✅ |
| Proxy SSE relay | Live E2E vs. mock Snowflake emitting the 11 documented event types (incl. analyst SQL + data_to_chart Vega-Lite): CORS preflight, key auth, 400s, upstream-401 passthrough, fail-closed empty key, and **true incremental streaming** (≥3 separate reads) | ✅ 6/6, rerun twice |
| Visual logic | 18 unit tests: SSE chunk-boundary torture (mid-line/mid-JSON/1-byte chunks/CRLF), CSV escaping, truncation, abort, AUTH sentinel, tool_use/SQL/chart extraction, findVegaSpec matrix | ✅ 18/18 |
| Bugs found & fixed | (1) operator-precedence in `findVegaSpec` string detection; (2) missing `TextDecoder` flush for streams ending mid-multibyte char. Both patched, re-tested, confirmed present in final bundle | ✅ |

## Execution strategy used
Three parallel subagents (package build / proxy E2E / unit tests) with non-overlapping file lanes and one-shot briefs; main thread did feature implementation first (tool activity + charts), then an independent verification gate: re-ran both test suites itself and byte-probed the rebuilt artifact rather than trusting agent reports.

## Deltas vs. original scaffold
- `agentClient.ts`: tool_use / tool_result.status / tool_result events; SQL + Vega-Lite extraction (`findVegaSpec`); decoder flush fix.
- `visual.ts`: activity trail, collapsible "SQL used" block, inline vega-embed charts, lazy assistant bubble, `import "./../style/visual.less"` (required for CSS to bundle).
- `package.json`: + vega / vega-lite / vega-embed.
- `proxy/agentProxy.ts`: handler extracted to exported `agentHandler` (behavior identical) for testability.
- New: `eslint.config.mjs` (pbiviz lint gate), `tools/` (mock Snowflake + E2E), `tests/` (unit suites), `deploy.sh`.
- `pbiviz.json`: placeholder support/GitHub URLs (required fields) — swap for real ones if you publish.

## Rerun everything
```
bash tests/run-tests.sh        # 18 unit tests
bash tools/run-e2e.sh          # mock-Snowflake streaming E2E
cd visual && ./node_modules/.bin/pbiviz package   # rebuild artifact
```

## Not verifiable from here (your ~30 min)
1. `snowflake/setup.sql` in Snowsight (edit placeholders; copy the PAT it prints).
2. `./deploy.sh` after filling the EDIT THESE block (prints proxy URL + access key).
3. Power BI: import `visual/dist/*.pbiviz` → Format ▸ Cortex Agent ▸ paste proxy URL → bind Context fields → first question prompts for the access key.
   Note: dev-mode `pbiviz start` requires `npx pbiviz install-cert` once on your machine.
