# Build & Verification Log

Plan executed 2026-06-12. Decisions: shared-key auth (v1), Azure Functions hosting, rich rendering (tool activity + SQL audit + Vega-Lite charts), full rigor.

## What was built and HOW it was verified

| Component | Verification | Result |
|---|---|---|
| `visual/dist/*.pbiviz` (330 KB) | Packaged with powerbi-visuals-tools 6.2.0 / api 5.11.0; archive inspected; bundle probed at byte level for our code, vega, CSS, and both bug-fix patches | ✅ |
| Proxy SSE relay | Live E2E vs. mock Snowflake emitting the 11 documented event types (incl. analyst SQL + data_to_chart Vega-Lite): CORS preflight, key auth, 400s, upstream-401 passthrough, fail-closed empty key, and **true incremental streaming** (≥3 separate reads) | ✅ 6/6, rerun twice |
| Visual logic | 18 unit tests: SSE chunk-boundary torture (mid-line/mid-JSON/1-byte chunks/CRLF), CSV escaping, truncation, abort, AUTH sentinel, tool_use/SQL/chart extraction, findVegaSpec matrix | ✅ 18/18 |
| Bugs found & fixed | (1) operator-precedence in `findVegaSpec` string detection; (2) missing `TextDecoder` flush for streams ending mid-multibyte char. Both patched, re-tested, confirmed present in final bundle | ✅ |

## How it was verified
Package build, proxy E2E, and unit suites were validated independently, then both
test suites were re-run together against the final rebuilt artifact (and the bundle
byte-probed) rather than trusting intermediate results.

## Deltas vs. original scaffold
- `agentClient.ts`: tool_use / tool_result.status / tool_result events; SQL + Vega-Lite extraction (`findVegaSpec`); decoder flush fix.
- `visual.ts`: activity trail, collapsible "SQL used" block, inline vega-embed charts, lazy assistant bubble, `import "./../style/visual.less"` (required for CSS to bundle).
- `package.json`: + vega / vega-lite / vega-embed.
- `proxy/agentProxy.ts`: handler extracted to exported `agentHandler` (behavior identical) for testability.
- New: `eslint.config.mjs` (pbiviz lint gate), `tools/` (mock Snowflake + E2E), `tests/` (unit suites), `deploy.sh`.
- `pbiviz.json`: placeholder support/GitHub URLs (required fields) — swap for real ones if you publish.

## Rerun everything
```
bash tests/run-tests.sh        # 28 unit tests
bash tools/run-e2e.sh          # mock-Snowflake streaming E2E (15-event stream)
cd visual && ./node_modules/.bin/pbiviz package   # rebuild artifact
```

## 2026-06-12 review pass (API drift + security + gaps)
Reviewed against current Snowflake and Microsoft documentation; every finding was
independently re-verified before any code changed. All three checks were re-run
after every step.

| Change | Why | Verified by |
|---|---|---|
| `system_execute_sql` tool blocks parsed (legacy type kept) | Snowflake release note 2026-04-13 renamed the response-stream block type; agent-spec type in `CREATE AGENT` unchanged | mock flipped to new type; test 14 updated; test 19 pins legacy back-compat |
| vega-embed 6.26 → **7.1.0** + `ast: true` | untrusted agent specs previously hit vega's `Function()` expression fallback; interpreter (vega-interpreter 2.2.1) evaluates instead | bundle probed for interpreter; vega-tooltip 1.0 escapeHTML default confirmed; tsconfig → `moduleResolution: bundler` (vega-embed 7 is ESM-only) |
| Proxy: constant-time key compare; generic upstream error detail | timing side-channel; Snowflake error bodies leak internals | e2e checks b/e/f |
| `storageService` → `storageV2Service` | removed in api 5.11.0 — key persistence silently no-oped | typed against installed d.ts; session-only placeholder when storage disabled |
| `options.jsonFilters` typed (cast removed) | typed on VisualUpdateOptions since api 2.2.0 | pbiviz compile |
| Prompt-injection framing (contextBuilder + setup.sql instructions) | untrusted cell values flow into the prompt; soft mitigation, hard boundary = read-only role | test 7b |
| New SSE events: `response.warning` / `.text.annotation` / `.chart` / `.table` | documented events were silently dropped | mock 11 → 15 events; tests 20-23; e2e count updated |
| Stop button + Escape; retry w/ backoff (`streamAgentWithRetry`); Rendering Events | gap features (user-selected) | tests 24-27 (never retries after delivery / on AUTH / past cap); pbiviz lint clean |
| Deps: formattingmodel 6.2.2, @azure/functions 4.16.0, typescript 5.9.3 | conservative floors; vega/vega-lite 5.x + tools 6.x deliberately held (see CLAUDE.md watch list) | all gates |
| Housekeeping: sandbox leftovers removed, real repo URLs in pbiviz.json | — | — |

Still never run against a live Snowflake account or real Power BI tenant.

## Not verifiable from here (your ~30 min)
SETUP.md is the full runbook; the short version:
1. Snowflake: `snowflake/grant-existing-agent.sql` for an existing agent, or
   `snowflake/setup.sql` from scratch. Copy the PAT it prints.
2. `./deploy.sh` after filling the EDIT THESE block (prints proxy URL + access key).
3. Power BI: build and import the visual, paste the proxy URL in Format > Cortex
   Agent, bind Context fields. The first question prompts for the access key.
   Dev-mode `pbiviz start` requires `npx pbiviz install-cert` once per machine.
