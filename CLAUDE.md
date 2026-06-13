# CLAUDE.md — Snowflake Cortex Chat for Power BI

Power BI custom visual (chat UI) → Azure Function SSE relay → Snowflake Cortex Agents `agent:run`.
The visual serializes its own filtered DataView (fields the author binds + active filters) into each
prompt, so the agent sees "what the user is looking at." Built and verified 2026-06-12 in a sandbox;
never yet run against a live Snowflake account or real Power BI tenant.

## Map
- `visual/` — pbiviz project. `src/visual.ts` (UI/orchestration), `src/agentClient.ts` (SSE client,
  tool/chart extraction), `src/contextBuilder.ts` (DataView→prompt), `src/settings.ts` (format pane),
  `capabilities.json` (dataRoles, **WebAccess privilege URL is a placeholder — must match deployed proxy host**).
  Prebuilt artifact: `visual/dist/*.pbiviz`.
- `proxy/src/functions/agentProxy.ts` — @azure/functions v4 handler; CORS, shared-key auth, SSE passthrough.
- `snowflake/setup.sql` — from-scratch role/warehouse/agent DDL, service user, PAT.
  `snowflake/grant-existing-agent.sql` — wire a service user to an existing agent (filled in for
  MSU's SPARTAN_TRENDS_CA). `deploy.sh` — Azure provisioning (MSU values prefilled).
- `tools/` — mock Snowflake SSE server + proxy E2E. `tests/` — 28 unit tests. `PLAN.md` — verification log.
- `SETUP.md` — handoff runbook for deploying the whole thing; keep it in sync with config changes.

## Commands
```bash
(cd visual && npm install --no-audit --no-fund)   # needed once; node_modules not in repo
(cd proxy  && npm install --no-audit --no-fund)
bash tests/run-tests.sh                            # 28 unit tests (compiles via proxy's tsc)
bash tools/run-e2e.sh                              # mock-Snowflake → proxy streaming E2E (6 checks)
(cd visual && ./node_modules/.bin/pbiviz package)  # rebuild .pbiviz into visual/dist/
```
All three must stay green after any change. Tests + mock encode the Snowflake SSE contract
(`response.text.delta`, `response.status`, `response.tool_use`, `response.tool_result[.status]`,
`response.thinking.delta`, `response.warning`, `response.text.annotation`, `response.chart`,
`response.table`; SQL tool blocks stream as `system_execute_sql`, legacy
`cortex_analyst_text_to_sql` still parsed) — if you change parsing, update mock + tests together.

## Verified already (don't re-prove; do challenge if you find drift)
Packaged .pbiviz (api 5.11.0, tools 6.x) with vega bundled; true incremental streaming through the
proxy; chunk-boundary-safe SSE parsing; fail-closed empty-key auth (constant-time compare); CSV
escaping/truncation. Bugs found+fixed: findVegaSpec precedence, TextDecoder flush. 2026-06-12 review
(verified against live docs): `system_execute_sql` replaced `cortex_analyst_text_to_sql` in response
streams Apr 2026 (agent-spec type unchanged — setup.sql is correct); CREATE AGENT / PAT / endpoint
syntax current; `acquireAADToken` still AppSource-only (README security model stands); vega-embed 7.1.0 renders
untrusted specs through vega-interpreter (`ast: true`); key storage uses storageV2Service
(storageService was removed in api 5.11.0); `options.jsonFilters` is properly typed (cast removed);
retry wrapper (streamAgentWithRetry) never retries after first delivery or on AUTH; Rendering Events
wired in update().

## Watch list (re-check on future reviews)
1. vega/vega-lite stay on 5.x until Snowflake `data_to_chart` output confirms vega-lite v6 `$schema`;
   bump both majors together (mock + findVegaSpec assume v5 today). powerbi-visuals-tools 7.x is a
   webpack/Node-polyfill major — needs a dedicated pass.
2. `acquireAADToken` / AADAuthentication eligibility for organizational visuals — if Microsoft ever
   lifts the AppSource-only restriction, rework the README security model (proper SSO, drop shared key).
3. Threads API v2: pass `thread_id`/`parent_message_id` on the existing `:run` endpoint instead of
   resending history; the `metadata` event carries the ids (currently ignored). Caveat before
   building: threads persist every message as sent, so each turn's REPORT CONTEXT block would
   accumulate server-side and the agent would see stale report snapshots — needs a context-delivery
   rethink first. History is already capped (MAX_TURNS=10, old contexts stripped), so resending is
   cheap; raise MAX_TURNS if users need longer recall.
4. Prompt injection is mitigated (untrusted-data framing both ends, read-only role), not solved —
   keep the agent role SELECT-only; revisit if tools gain write capability.
5. Markdown rendering of answers stays deferred: it would trade away the textContent-only XSS posture.

## Constraints
- Certified-visual rules forbid web access — this visual is intentionally uncertified/organizational; don't "fix" that.
- No secrets in format-pane settings or pbix; key stays in localStorage/memory, Snowflake creds stay in the proxy.
- `capabilities.json` WebAccess privilege URL is still a placeholder — must match the deployed proxy host.
