# Snowflake Cortex Chat for Power BI

A chat window that lives inside a Power BI report and talks to a Snowflake Cortex
agent. Every question automatically includes what the user is currently looking
at: the fields bound to the visual, filtered by whatever slicers and filters are
active on the page.

```
┌─ Power BI report ────────────┐      ┌─ Azure Function ─┐      ┌─ Snowflake ────────────┐
│  ┌─ Cortex Chat visual ───┐  │ SSE  │  agentProxy      │ SSE  │  agent:run             │
│  │ chat UI                │◄─┼──────┤  - CORS          │◄─────┤  Cortex agent          │
│  │ + filtered DataView ───┼──┼─────►│  - holds PAT     ├─────►│  - text-to-SQL tool    │
│  └────────────────────────┘  │ POST │  - relays stream │      │  - semantic view       │
└──────────────────────────────┘      └──────────────────┘      └────────────────────────┘
```

**Setting it up?** Follow [SETUP.md](SETUP.md). It's a step-by-step runbook and
assumes no familiarity with this codebase.

## How the context works

Power BI hands a custom visual whatever fields the report author drags into its
field wells, already filtered by every active slicer, filter, and cross-highlight.
Before each question, the visual serializes that data (field names, up to 200 rows
as CSV, plus the active filter definitions) into a `REPORT CONTEXT` block at the
top of the prompt. The agent sees what the user sees, and nothing else: fields that
aren't bound to the visual are invisible to it.

The chat renders more than text. Tool calls show up as a muted activity trail,
generated SQL lands in a collapsible "SQL used" block so analysts can audit
answers, charts the agent produces render inline (Vega-Lite via vega-embed), and
result tables render as actual tables. There's a Stop button for runaway answers,
and transient network failures retry automatically with backoff.

## Repo layout

| Path | What it is |
|---|---|
| `visual/` | The Power BI visual (pbiviz project). Build output goes to `visual/dist/` |
| `visual/src/visual.ts` | UI and orchestration: chat bubbles, charts, tables, the key prompt |
| `visual/src/agentClient.ts` | SSE client: parses the agent's event stream, retry logic |
| `visual/src/contextBuilder.ts` | Turns the DataView into the REPORT CONTEXT prompt block |
| `visual/src/settings.ts` | The Format-pane settings (proxy URL, row cap, report description) |
| `proxy/src/functions/agentProxy.ts` | Azure Function: auth, CORS, SSE relay. The only place Snowflake credentials live |
| `snowflake/grant-existing-agent.sql` | Wire a service user + PAT to an agent that already exists |
| `snowflake/setup.sql` | Full from-scratch setup: role, warehouse, agent, service user, PAT |
| `deploy.sh` | One-command Azure deploy. Fill in the EDIT THESE block first |
| `tests/`, `tools/` | 28 unit tests and a streaming end-to-end test against a mock Snowflake |
| `PLAN.md` | Build and review log: what was verified and how |

After any code change, these three must pass (see CLAUDE.md if you're using an AI
coding tool against this repo):

```bash
bash tests/run-tests.sh
bash tools/run-e2e.sh
(cd visual && npx pbiviz package)
```

## Design notes

- **Context rides the latest turn only.** Older turns are resent without their
  context blocks to keep token costs down. Each new question carries fresh
  context, so slicer changes between questions are picked up.
- **1000-row DataView window, 200-row prompt cap.** Both deliberate. Bind
  aggregated fields, not raw fact tables: the goal is the story of the page, not a
  data dump. The row cap is adjustable in the Format pane.
- **The proxy is stateless.** Full message history travels with each call. If
  histories get long, the upgrade path is Snowflake threads: pass `thread_id` and
  `parent_message_id` on the same `:run` endpoint and send only the new message.
  The `metadata` event carries the IDs; the client currently ignores it.
- **Untrusted input is treated as such.** Cell values go into the prompt, so the
  context block and the agent's instructions both state that report data is data,
  not instructions. Agent-supplied Vega-Lite specs render with `ast: true`, which
  evaluates spec expressions in an interpreter instead of compiling them to
  JavaScript. All text reaches the DOM through `textContent` (never `innerHTML`),
  including the rendered tables. Keep it that way.
- **SQL tool blocks stream as `system_execute_sql`** since Snowflake's April 2026
  change. The old `cortex_analyst_text_to_sql` type is still parsed for
  compatibility, and it remains the correct tool type inside the agent
  *definition* (only the response stream renamed).

## Security model

| Layer | Today (pilot) | Production upgrade |
|---|---|---|
| Visual to proxy | Shared key in an `x-proxy-key` header, stored per user via the visual storage API. Constant-time comparison, fails closed if unset | Entra ID JWT validation in the proxy. Note: private visuals cannot use Power BI's `acquireAADToken` SSO API (AppSource visuals only, still true as of mid-2026), so the realistic path is a `launchUrl()` OAuth popup or AppSource publication |
| Proxy to Snowflake | One service-user PAT held in Function app settings. Everyone shares that role's access | External OAuth integration with Entra ID; proxy forwards per-user tokens so Snowflake RBAC and row access policies apply per person |
| Network | Snowflake network policy open by default in the scripts | Pin the policy to the Function's outbound IPs; put the PAT behind a Key Vault reference |

Things the proxy does on purpose: Snowflake error bodies are logged server-side
but never relayed to the browser (they can reveal account internals), and the
CORS wildcard only applies to origin-less clients like Power BI Desktop, where
CORS isn't enforceable anyway.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Could not reach proxy" | The Function host isn't in the visual's `WebAccess` privilege (edit `capabilities.json`, repackage, reimport), or CORS: check `ALLOWED_ORIGINS` on the Function App |
| Works in Desktop, not in the Service | Tenant blocks SDK visuals. Distribute through Organizational visuals instead of file import |
| 401 from the proxy | Key mismatch. Re-enter the access key (it's stored per user, per browser) |
| `snowflake_error` with 401/403 | PAT expired (90-day default), the network policy blocks the Function's IP, or the service role lost USAGE on the agent. Details are in the Function's logs, not the browser |
| Answer arrives all at once instead of streaming | The hosting plan buffers responses. Flex Consumption streams; other plans may not. Functionally it still works |
| Empty or vague answers | Look at the context chip. Are the right fields bound? Is the row cap eating the data? Is the semantic view any good? |
| Charts don't render, raw JSON shows instead | The spec failed validation or used expressions the interpreter rejects. The raw spec is shown on purpose so you can see what the agent sent |
| `pbiviz` certificate errors on `pbiviz start` | `npx pbiviz install-cert`, once per machine |

## Known limitations

- The visual can only see fields bound to it. It can't read other visuals on the
  page, though page-level filters and slicers affect its data like any other
  visual, which covers most "what am I looking at" questions.
- It can't be a certified visual: certification forbids web access, and calling
  the proxy is the whole point. Organizational-visual distribution is the
  intended path.
- Chat history lives in memory for the session. Power BI may unload the visual on
  page switches, which clears it. The access key survives (browser storage); if a
  tenant admin disables visual storage, the key becomes session-only and the
  input placeholder says so.
- One question at a time per visual: Send locks while a request is in flight.
  Stop (or Escape) cancels it.
