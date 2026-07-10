# Phase 2 handoff — from code-complete to live

**Audience:** a future AI assistant (any capability level) or a human engineer
taking Phase 2 from "everything builds and passes tests" to "running against
the real Snowflake account inside the real Power BI tenant." Assumes no
memory of this project. Companion docs: [SETUP.md](SETUP.md) is the
step-by-step deployment runbook (keep it in sync with any config change);
[CLAUDE.md](CLAUDE.md) carries the verified-facts and watch lists;
[PLAN.md](PLAN.md) is the historical verification log. Phase 1 (the
`phase1/` folder) is a separate throwaway demo with its own handoff
([phase1/HANDOFF.md](phase1/HANDOFF.md)) — nothing there is needed here.

**Non-technical summary:** Phase 2 is the "real" product. A chat visual sits
in a Power BI report; when a user asks a question, the visual sends it (plus
a snapshot of what the user is currently looking at) over HTTPS to a small
relay service in Azure, which securely forwards it to the Snowflake Cortex
Agent and streams the answer back word-by-word into the chat. Unlike Phase 1,
nothing round-trips through Power BI's query engine — so it streams, supports
conversation history, and renders charts. All the code is written and tested
against a simulated Snowflake. **It has never been pointed at the real one.**
This document is the plan for doing that.

---

## 1. Architecture (one minute)

```
Power BI report
  └─ custom visual (visual/)  — chat UI; serializes the user's filtered data
       │ HTTPS + shared key            view into each prompt ("report context")
       ▼
Azure Function (proxy/)      — agentProxy: CORS, shared-key auth (constant-
       │ PAT auth                time compare, fail-closed), SSE passthrough
       ▼
Snowflake Cortex Agents      — POST /api/v2/databases/.../agents/{name}:run
                               streams response.text.delta / tool_use /
                               tables / charts back up the same pipe
```

Security model: the Snowflake credential (a service-user PAT) lives ONLY in
the Azure Function's app settings. The visual holds only the proxy URL + a
shared key (stored via the host's storageV2 service / localStorage — never in
the .pbix). The Snowflake role is SELECT-only, which is the blast-radius cap
for prompt injection (mitigated with untrusted-data framing at both ends, not
"solved"). The visual is deliberately **uncertified/organizational** —
certified visuals may not make web requests; do not "fix" that.

## 2. Status: what exists and what is verified

| Piece | Where | State |
|---|---|---|
| Chat visual (streaming UI, context builder, SSE client, vega charts) | `visual/` (prebuilt: `visual/dist/*.pbiviz`) | Code-complete; 28 unit tests green; packages clean (api 5.11.0) |
| SSE relay | `proxy/src/functions/agentProxy.ts` | Code-complete; exercised by mock e2e |
| Mock Snowflake + E2E harness | `tools/` (`run-e2e.sh`, 6 checks) | Green; encodes the Snowflake SSE contract incl. `system_execute_sql` (Apr 2026) and legacy `cortex_analyst_text_to_sql` |
| Snowflake DDL | `snowflake/setup.sql` (from scratch) / `snowflake/grant-existing-agent.sql` (wire to the existing `DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA`, prefilled) | Written, reviewed against live docs 2026-06-12; never executed against the real account |
| Azure provisioning | `deploy.sh` (values prefilled) | Written; never run |
| Runbook | `SETUP.md` | Written for the whole flow |

Verified in the 2026-06-12 review (do not re-prove, do challenge on drift):
true incremental streaming; chunk-boundary-safe SSE parsing; fail-closed
auth; retry wrapper that never retries after first delivery or on AUTH;
vega-embed 7.1.0 rendering untrusted specs through vega-interpreter;
CSV escaping/truncation of context; rendering events wired.

**What has NEVER been done:** any call against the real Snowflake account;
any run inside the real Power BI tenant/Service; any Azure deployment.

## 3. Critical prerequisite to investigate FIRST: network path to Snowflake

The account host in use is **`msu-prod.east-us-2.privatelink.snowflakecomputing.com`**
— a PrivateLink endpoint, reachable only from inside MSU's network (this is
why Ryan's machine, with broken ZScaler, cannot connect). **A default Azure
Function on the public internet cannot reach a PrivateLink host.** Before any
deployment work, answer with the MSU cloud/network team:

1. Can a Function App be deployed **inside MSU's Azure estate** with VNet
   integration + private DNS so it resolves and reaches the privatelink
   host? (Preferred; `deploy.sh` provisions a plain public Function App and
   would need VNet flags added.)
2. Or does the Snowflake account also allow its **public endpoint**
   (`<account>.snowflakecomputing.com`) for service traffic, gated by
   Snowflake network policies that could allowlist the Function's egress IPs?
3. Or must the proxy live somewhere else entirely (on-prem container, MSU
   API gateway)? The proxy is a single stateless HTTP handler — it ports
   easily, but the visual's `capabilities.json` WebAccess privilege URL must
   list whatever host it ends up on (see §5.4).

Everything else in this plan is mechanical; this is the one open design
question. Do not skip it — a deployed proxy that cannot reach Snowflake
fails with connection timeouts that look like auth errors.

**Related — the account host.** The Phase 2 artifacts are prefilled with a
default account host that must be confirmed before deploying:
`deploy.sh` sets
`SNOWFLAKE_ACCOUNT_URL=https://msu-prod.snowflakecomputing.com`, and the curl
smoke tests in `snowflake/grant-existing-agent.sql` and `SETUP.md` use the
same `msu-prod` host. **Confirm these against the actual account.** The
PrivateLink form of the host is
`msu-prod.east-us-2.privatelink.snowflakecomputing.com`. Before Stage 1/2,
replace the host in all three files with whatever §3's networking answer
says the proxy should use — and treat "prefilled" in the table above as
"prefilled with defaults that need this one substitution."

## 4. Division of labor (unchanged from Phase 1)

Ryan cannot reach Snowflake from his machine and cannot execute anything
requiring that connectivity; a colleague/analyst with access runs Snowflake
worksheets and in-tenant Power BI tests. Azure work depends on who holds
subscription access. All instructions produced for the analyst must be
fluff-free, fully self-contained (every script/SQL block inline), with exact
click paths and screenshots at each step, and batched as decision trees (each
exchange takes days — never send a script that stops at its first failure).

## 5. Go-live project outline (in order)

### Stage 0 — refresh & verify the codebase (½ day, any model can do this)
- `(cd visual && npm install --no-audit --no-fund)` and same in `proxy/`.
- Gates all green: `bash tests/run-tests.sh` (28), `bash tools/run-e2e.sh`
  (6), `(cd visual && ./node_modules/.bin/pbiviz package)`.
- Drift check against live docs (the CLAUDE.md watch list): vega/vega-lite
  still 5.x in Snowflake `data_to_chart` output; `agent:run` endpoint + PAT
  syntax unchanged; `system_execute_sql` still current. Record findings in
  PLAN.md.

### Stage 1 — Snowflake side (analyst; ~1 hour)
- Run `snowflake/grant-existing-agent.sql` (prefilled for the existing agent)
  under a sufficiently-privileged role: creates/wires the service user
  `SVC_PBI_CORTEX_CHAT`, role grants (agent USAGE, semantic view, warehouses),
  and a PAT **restricted to the role**.
- Validation: the script's own smoke test (its step 6) is a **curl against
  the REST `:run` endpoint with the PAT** — fix its host per §3 first. As an
  optional extra sanity check (not in the script), a Snowsight worksheet run
  of `SELECT SNOWFLAKE.CORTEX.DATA_AGENT_RUN('DBS_ANALYTICS_AI.
  SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA', $$...$$)` under the role
  confirms agent access independently of REST/PAT plumbing.
- Deliverables back: confirmation + the PAT (transmitted securely, never
  committed, never pasted into the repo or a .pbix).

### Stage 2 — Azure side (whoever holds the subscription; ~1–2 hours + §3's answer)
- Resolve §3 first. Then `deploy.sh` (edit for VNet flags if applicable):
  resource group, Function App, and app settings — the exact names the proxy
  reads (verified against `agentProxy.ts` / `deploy.sh`):
  `SNOWFLAKE_ACCOUNT_URL`, `SNOWFLAKE_PAT`, `AGENT_DATABASE`, `AGENT_SCHEMA`,
  `AGENT_NAME`, `PROXY_API_KEY` (generate long random — this is the shared
  key the visual holds), `ALLOWED_ORIGINS` (defaults to
  `https://app.powerbi.com`; comma-separated for more origins).
- **Host name rule:** `visual/capabilities.json` WebAccess privileges list
  `pbi-cortex-chat-proxy.azurewebsites.net`. If the deployed host differs,
  update capabilities.json, re-run `pbiviz package`, and use the new .pbiviz
  everywhere. Mismatch = the visual's requests are blocked by the host.
- Smoke test from any machine (proxy is public even if Snowflake isn't):
  the SETUP.md curl — the shared key travels in the **`x-proxy-key`** request
  header. Expect an SSE stream for a valid key and 401-style fail-closed
  behavior for a missing/wrong key (never a hang).

### Stage 3 — first live end-to-end in Power BI Desktop (analyst; ~1 hour)
- Import `visual/dist/*.pbiviz` into a report with real data fields.
- Format pane: proxy URL + shared key (key prompt appears in the visual; it
  stores via storageV2/localStorage — re-entered per machine/browser).
- Bind context fields; ask a question; verify: streaming text appears
  incrementally (not all at once), Stop works, a chart question renders a
  vega chart, GENERATED_SQL shows when the agent runs SQL.
- Capture screenshots per the Phase 1 discipline (timestamped observations).

### Stage 4 — Power BI Service (tenant admin + analyst; ~half day elapsed)
- Tenant prerequisites: uncertified/organizational visuals allowed (or the
  visual added to the org visuals store by an admin); no tenant policy
  blocking the WebAccess domain.
- Publish the Desktop report to a pilot workspace; repeat Stage 3's checks in
  the browser (CORS is the thing being tested here — the Service origin must
  be in `ALLOWED_ORIGINS`).
- Check both desktop app and browser; check one non-author user.

### Stage 5 — structured test pass (analyst; one session, batched)
Run as a single decision-tree script (Phase 1 style). Cover:
1. Streaming correctness: long answer arrives incrementally; no truncation at
   chunk boundaries (multi-KB answers).
2. Conversation memory: follow-up question references the prior answer
   (history is resent, capped at MAX_TURNS=10 with old contexts stripped).
3. Report context: change a slicer, ask "what am I looking at" — the answer
   must reflect the filtered view; row cap (Max context rows) respected.
4. Tool transparency: a SQL-requiring question surfaces `system_execute_sql`
   SQL; a chart question renders (vega 5 spec).
5. Failure modes: wrong shared key (immediate clean error, no retry storm);
   proxy stopped (clean error); agent timeout (Stop works; retry behaves).
6. Security spot-checks: key not present in the saved .pbix (inspect file);
   a cell value containing "ignore previous instructions" is treated as data
   (injection framing); role cannot write (attempt via a question asking the
   agent to modify data — it must refuse/fail).
7. Cost/perf notes: time-to-first-token, tokens/minute feel, concurrent users
   (two analysts simultaneously).
Record everything in PLAN.md; file defects as GitHub issues; fix → re-run
gates → PR per repo flow.

### Stage 6 — pilot rollout
- Admin uploads the .pbiviz as an **organizational visual** (AppSource is out
  of scope — cert forbids web access).
- Pilot workspace + 3–5 users; a one-page user guide (what it can answer,
  latency expectations, cost per question, "answers come from the agent — 
  verify numbers before decisions").
- Collect a week of feedback → prioritize → iterate.

## 6. Known future work (post-live backlog, in rough order)

1. **Markdown rendering** of answers — currently plain text only (textContent,
   the XSS posture). Any change must keep sanitization airtight; consider a
   vetted markdown renderer with an allowlist. Deliberately deferred.
2. **Threads API v2** — pass `thread_id`/`parent_message_id` instead of
   resending history. CAVEAT (recorded in CLAUDE.md): threads persist every
   message server-side, so per-turn REPORT CONTEXT blocks would accumulate
   and go stale — needs a context-delivery redesign first. Not before the
   pilot.
3. **Vega/vega-lite major bumps** — stay on 5.x until Snowflake chart output
   proves v6 `$schema`; bump both majors together with mock + findVegaSpec.
4. **powerbi-visuals-tools 7.x** — webpack/Node-polyfill major; dedicated pass.
5. **Phase 3 (Entra ID passthrough, per-user security):** blocked on
   Microsoft — `acquireAADToken` is AppSource-certified-visuals-only, and
   certification forbids web access. Track that policy; if it changes,
   Phase 3 replaces the shared key with real SSO and the README security
   model gets rewritten. Until then, everyone shares the one read-only role.

## 7. Working rules for the next model/developer

- Gates before every PR: `bash tests/run-tests.sh` (28), `bash
  tools/run-e2e.sh` (6), `(cd visual && ./node_modules/.bin/pbiviz package)`.
  If you change SSE parsing, update `tools/` mock + tests TOGETHER — they
  encode the Snowflake contract.
- Branch → PR → squash-merge; stage specific files (never `git add -A`);
  Co-Authored-By trailer; main is PR-only by convention.
- No secrets anywhere in the repo, format-pane settings, or .pbix files.
- This repo is PRIVATE and carries real MSU identifiers deliberately; if it
  ever goes public, scrub them first.
- Keep SETUP.md, CLAUDE.md, and PLAN.md updated as you execute — they are the
  institutional memory that survives model handoffs.
