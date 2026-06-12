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
- `snowflake/setup.sql` — role/warehouse/agent DDL, service user, PAT. `deploy.sh` — Azure provisioning.
- `tools/` — mock Snowflake SSE server + proxy E2E. `tests/` — 18 unit tests. `PLAN.md` — verification log.

## Commands
```bash
(cd visual && npm install --no-audit --no-fund)   # needed once; node_modules not in repo
(cd proxy  && npm install --no-audit --no-fund)
bash tests/run-tests.sh                            # 18 unit tests (compiles via proxy's tsc)
bash tools/run-e2e.sh                              # mock-Snowflake → proxy streaming E2E (6 checks)
(cd visual && ./node_modules/.bin/pbiviz package)  # rebuild .pbiviz into visual/dist/
```
All three must stay green after any change. Tests + mock encode the Snowflake SSE contract
(`response.text.delta`, `response.status`, `response.tool_use`, `response.tool_result[.status]`,
`response.thinking.delta`) — if you change parsing, update mock + tests together.

## Verified already (don't re-prove; do challenge if you find drift)
Packaged .pbiviz (api 5.11.0, tools 6.2.0) with vega bundled; true incremental streaming through the
proxy; chunk-boundary-safe SSE parsing; fail-closed empty-key auth; CSV escaping/truncation. Two bugs
already found+fixed: findVegaSpec precedence, TextDecoder flush.

## Review priorities (in order)
1. **API drift vs. current docs.** Snowflake Cortex Agents Run API event types/payloads
   (docs.snowflake.com /user-guide/snowflake-cortex/cortex-agents-run), threads API, PAT semantics,
   `CREATE AGENT` spec syntax in setup.sql. Power BI: latest powerbi-visuals-api/tools versions;
   whether the Authentication API (`acquireAADToken`, AADAuthentication privilege) STILL excludes
   private/org visuals — if that changed, it unlocks proper SSO and §7 of README should be reworked.
2. **Security.** Shared-key model; CORS `"*"` branch for null-Origin (Desktop) — no credentials used,
   but review; visual stores key via storageService (admin switch may disable → memory fallback);
   prompt-injection surface: untrusted cell values flow into the agent prompt (REPORT CONTEXT block);
   vega-embed renders agent-supplied specs — assess vega expression risk, consider `ast: true` /
   expression interpreter or spec sanitization; XSS posture (all text via textContent — keep it that way).
3. **Dependency updates.** `npm outdated` in visual/ and proxy/; vega/vega-lite/vega-embed majors;
   @azure/functions; typescript. Bump conservatively; pbiviz package must still succeed.
4. **Gaps worth implementing.** Stop/cancel button (AbortController already wired); fetchMoreData for
   >1000-row dataViews; Snowflake threads instead of resending history; Rendering Events API
   (pbiviz suggests it); markdown rendering of answers (currently plain text); `response.text.annotation`
   citations; retry/backoff on transient proxy failures.
5. **Known wobbly spot:** `(options as any).jsonFilters` in visual.ts — verify against current
   VisualUpdateOptions typings and the declared `general.filter` object in capabilities.json; fix typing
   or remove the cast.

## Constraints
- Certified-visual rules forbid web access — this visual is intentionally uncertified/organizational; don't "fix" that.
- No secrets in format-pane settings or pbix; key stays in localStorage/memory, Snowflake creds stay in the proxy.
- `pbiviz.json` supportUrl/gitHubUrl are placeholders (github.com/ryan25r9/cortex-chat-visual) — update if a real repo exists.
- Sandbox leftovers safe to delete in a real checkout: `visual/tsconfig.check.json`, `visual/webpack.statistics.prod.html`, `tests/build/`.
