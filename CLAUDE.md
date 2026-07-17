# CLAUDE.md — Snowflake Cortex Chat for Power BI

Power BI custom visual (chat UI) → Azure Function middleware (SSE relay) → Snowflake Cortex
Agents `agent:run`. The visual serializes its own filtered DataView (fields the author binds +
active filters) into each prompt, so the agent sees "what the user is looking at." Built and
verified 2026-06-12 in a sandbox; never yet run against a live Snowflake account or real Power BI
tenant. **ARCHITECTURE.md is the design source of truth** — middleware models (bundled proxy vs
MSU internal AI platform "MSAI"), auth ladder, session design, CORS, networking prerequisite.

An earlier middleware-free approach ("Phase 1", Dynamic-M-parameter round trip) was abandoned
2026-07-16 — custom visuals cannot drive Dynamic M parameters (host rewrites their filters).
See docs/phase1-postmortem.md; its code exists only in git history. Don't resurrect it.

## Map
- `visual/` — pbiviz project (v2.0). `src/visual.ts` (UI/orchestration: themed chat, tool chips,
  SQL/chart/table cards, sticky autoscroll, storageV2 session persistence under `cortexChatSession`,
  credential prompt), `src/richText.ts` (safe markdown-subset renderer — DOM-built, injectable doc,
  http(s)-only links via launchUrl; unit tests grep-ban innerHTML across visual/src),
  `src/agentClient.ts` (SSE client; takes AgentConnection {url, authMode, credential,
  conversationId} → x-proxy-key OR Bearer, never both), `src/contextBuilder.ts` (DataView→prompt),
  `src/settings.ts` (format pane: agent card incl. Auth mode; appearance card: title, accent color,
  suggested questions), `capabilities.json` (dataRoles, **WebAccess privilege URL set to
  `pbi-cortex-chat-proxy.azurewebsites.net` — must match the deployed middleware host**).
  Prebuilt artifact: `visual/dist/*.pbiviz` (force-added; dist/ is otherwise gitignored).
- `proxy/src/functions/agentProxy.ts` — @azure/functions v4 handler; CORS, SSE passthrough.
  `proxy/src/functions/auth.ts` — pluggable caller auth (AUTH_MODE: shared-key | entra bearer
  via JWKS; unknown modes fail closed; jose pinned to v5 — v6 dropped the CJS build).
- `snowflake/setup.sql` — from-scratch role/warehouse/agent DDL, service user, PAT.
  `snowflake/grant-existing-agent.sql` — wire a service user to an existing agent (filled in for
  MSU's SPARTAN_TRENDS_CA). `deploy.sh` — Azure provisioning (MSU values prefilled).
- `tools/` — mock Snowflake SSE server + proxy E2E. `tests/` — unit tests.
- `SETUP.md` — deployment runbook; keep in sync with config changes. `ARCHITECTURE.md` — design
  doc; keep in sync with structural changes (auth modes, session handling, endpoints).
- `.github/workflows/ci.yml`, `.githooks/post-commit`, `CONTRIBUTING.md` — branch→PR flow,
  main is PR-only by convention. The post-commit hook pushes the current branch, never main.

## Commands
```bash
(cd visual && npm install --no-audit --no-fund)   # needed once; node_modules not in repo
(cd proxy  && npm install --no-audit --no-fund)
bash tests/run-tests.sh                            # unit tests (compiles via proxy's tsc)
bash tools/run-e2e.sh                              # mock-Snowflake → proxy streaming E2E
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
syntax current; `acquireAADToken` still AppSource-only (ARCHITECTURE.md auth ladder stands);
vega-embed 7.1.0 renders untrusted specs through vega-interpreter (`ast: true`; findVegaSpec strips
`usermeta` — specs would otherwise override embed options via usermeta.embedOptions and flip ast
back to the Function-compiler path; regression test 31 guards it); key storage uses
storageV2Service (storageService was removed in api 5.11.0); `options.jsonFilters` is properly
typed; retry wrapper (streamAgentWithRetry) never retries after first delivery or on AUTH;
Rendering Events wired in update(). 2026-07-16 research pass (4 lenses + adversarial synthesis):
custom visuals fetch with `Origin: null` (sandboxed iframe, opaque origin; Service CERTAIN,
Desktop null-or-absent HIGH; no privilege/certification/embedding yields a real origin) — proxy
therefore defaults ALLOWED_ORIGINS="*", never sends Allow-Credentials, and CORS is never auth.

## Watch list (re-check on future reviews)
1. vega/vega-lite stay on 5.x until Snowflake `data_to_chart` output confirms vega-lite v6 `$schema`;
   bump both majors together (mock + findVegaSpec assume v5 today). powerbi-visuals-tools 7.x is a
   webpack/Node-polyfill major — needs a dedicated pass.
2. `acquireAADToken` / AADAuthentication eligibility for organizational visuals — if Microsoft ever
   lifts the AppSource-only restriction, per-user SSO gets dramatically simpler (see ARCHITECTURE.md
   auth ladder).
3. Threads API v2: pass `thread_id`/`parent_message_id` on the existing `:run` endpoint instead of
   resending history; the `metadata` event carries the ids (currently ignored). Caveat before
   building: threads persist every message as sent, so each turn's REPORT CONTEXT block would
   accumulate server-side and the agent would see stale report snapshots — needs a context-delivery
   rethink first. History is already capped (MAX_TURNS=10, old contexts stripped), so resending is
   cheap; raise MAX_TURNS if users need longer recall.
4. Prompt injection is mitigated (untrusted-data framing both ends, read-only role), not solved —
   keep the agent role SELECT-only; revisit if tools gain write capability.
5. Rich text in answers must stay DOM-built (no `innerHTML`, no HTML parsing of agent output) —
   that IS the XSS posture. Any markdown-library proposal is a regression; reject it.
6. MSAI platform middleware integration (ARCHITECTURE.md Model B) is blocked on the open-questions
   checklist — endpoint contract, token acquisition, CORS (they must allow `*` + preflight, NOT an
   app.powerbi.com allowlist — visuals present Origin: null), streaming support. Don't build
   against guessed answers; the notes that exist are marked unverified.
7. The null-Origin behavior is undocumented Microsoft implementation (changed once, March 2016).
   If visuals ever get a real origin, tighten ALLOWED_ORIGINS to it (allowlist branch exists).

## Constraints
- Certified-visual rules forbid web access — this visual is intentionally uncertified/organizational; don't "fix" that.
- No secrets in format-pane settings or pbix; key/token stays in localStorage/memory, Snowflake creds stay in the middleware.
- `capabilities.json` WebAccess privilege URL must match the deployed middleware host(s); changing
  hosts requires rebuild + re-import (an approval cycle — batch host additions).
- This repo is private and MSU-branded; identifiers (roles, hosts, agent names) follow the
  `SG_MSU_*` / `msu-prod` convention.
