# Snowflake Cortex Chat — Power BI Custom Visual

A chat window that lives **inside** a Power BI report, talks to a **Snowflake Cortex Agent**, and automatically includes the report's current filter context with every question.

```
┌─ Power BI report ────────────┐      ┌─ Azure Function ─┐      ┌─ Snowflake ────────────┐
│  ┌─ Cortex Chat visual ───┐  │ SSE  │  agentProxy      │ SSE  │  agent:run             │
│  │ chat UI                │◄─┼──────┤  • CORS          │◄─────┤  REPORT_CHAT_AGENT     │
│  │ + filtered DataView ───┼──┼─────►│  • holds PAT     ├─────►│  • Cortex Analyst      │
│  └────────────────────────┘  │ POST │  • relays stream │      │  • semantic view       │
└──────────────────────────────┘      └──────────────────┘      └────────────────────────┘
```

**How "context" works (the key intuition):** a custom visual receives whatever fields the report author drags into its field wells — *already filtered* by every active slicer, filter, and cross-highlight. The visual serializes that view (schema + capped rows + active filters) into the prompt. The agent literally sees what the user sees. It cannot see fields you don't bind.

## Repo layout

| Path | What it is |
|---|---|
| `visual/` | The .pbiviz project — **prebuilt artifact in `visual/dist/`** |
| `proxy/` | Azure Function — CORS + secrets + SSE relay |
| `snowflake/setup.sql` | Role, warehouse, agent, service user, PAT |
| `deploy.sh` | One-command Azure deploy (fill the EDIT THESE block) |
| `tests/`, `tools/` | 18 unit tests + mock-Snowflake streaming E2E (`bash tests/run-tests.sh`, `bash tools/run-e2e.sh`) |
| `PLAN.md` | Build/verification log — what was tested and how |

**Build status:** packaged .pbiviz verified, proxy streaming proven live against a mock Snowflake (6/6), visual logic 18/18 unit tests. Chat renders streamed text, a tool-activity trail, a collapsible "SQL used" audit block, and inline Vega-Lite charts from `data_to_chart`.

---

## Phase 0 — Prerequisites (½ day)

1. Node.js 20+, plus [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local) (`npm i -g azure-functions-core-tools@4`).
2. Snowflake: `ACCOUNTADMIN` (or delegated) access; a **semantic view** over your reporting tables — this is 80% of answer quality. Build it in Snowsight ▸ AI & ML ▸ Studio.
3. Power BI: enable **Developer mode** (Fabric: User settings ▸ Developer settings ▸ Power BI Developer mode) so `pbiviz start` live-reloads in the Service.
4. Tenant admin: confirm SDK/uncertified visuals aren't blocked (Fabric Admin portal ▸ Tenant settings ▸ "Visuals created by the Power BI SDK").

## Phase 1 — Snowflake (1–2 hrs)

1. Edit the `<placeholders>` in `snowflake/setup.sql` (semantic view name, data grants).
2. Run it. Copy the PAT it prints — shown once.
3. Run the smoke-test `curl` at the bottom of the file. You should see `event: response.status` / `response.text.delta` lines stream back. Don't proceed until this works.

> Agents run under the calling user's **default role and default warehouse** — that's why the script sets both on `SVC_PBI_CORTEX_CHAT`.

## Phase 2 — Proxy (½ day)

```bash
cd proxy
npm install
cp local.settings.json.example local.settings.json   # fill in values
npm start                                            # http://localhost:7071/api/agent
```

Test locally:

```bash
curl -N -X POST http://localhost:7071/api/agent \
  -H "Content-Type: application/json" -H "x-proxy-key: <your PROXY_API_KEY>" \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}'
```

Deploy — **easiest: fill in the EDIT THESE block in `../deploy.sh` and run it** (creates everything below, prints your proxy URL + access key). Manual equivalent:

```bash
az group create -n rg-cortex-chat -l eastus2
az functionapp create -g rg-cortex-chat -n <FUNC_APP_NAME> \
  --flexconsumption-location eastus2 --runtime node --runtime-version 20 \
  --storage-account <newstorageacct>
az functionapp config appsettings set -g rg-cortex-chat -n <FUNC_APP_NAME> --settings \
  SNOWFLAKE_ACCOUNT_URL=... SNOWFLAKE_PAT=... AGENT_DATABASE=AI_DB \
  AGENT_SCHEMA=AGENTS AGENT_NAME=REPORT_CHAT_AGENT \
  PROXY_API_KEY=... ALLOWED_ORIGINS=https://app.powerbi.com
cd proxy && npm run build && func azure functionapp publish <FUNC_APP_NAME>
```

Then tighten the Snowflake network policy in `setup.sql` to the Function's outbound IPs, and move `SNOWFLAKE_PAT` into Key Vault references when convenient.

## Phase 3 — The visual (1–2 days incl. polish)

```bash
cd visual
npm install
```

1. **Edit `capabilities.json`** → replace `https://YOUR-PROXY.azurewebsites.net` in the `WebAccess` privilege with your Function host. Calls to undeclared hosts are blocked by Power BI.
2. Dev loop: `npx pbiviz start`, open a report in the Service, add the **Developer visual** from the visualizations pane.
3. In the visual's **Format ▸ Cortex Agent** pane set: Proxy URL (`https://<FUNC_APP_NAME>.azurewebsites.net/api/agent`), optional report description.
4. First question will prompt for the **access key** → paste `PROXY_API_KEY` (stored per-user via the LocalStorage API, never in the .pbix).
5. **Bind context**: drag the page's key dimensions/measures into **Context fields**. Watch the header chip ("context: 5 fields · 312 rows"). Move a slicer — the chip updates; that's the context the agent gets.
6. Package: `npx pbiviz package` → `dist/*.pbiviz`.

## Phase 4 — Distribute (1 hr + admin)

- Quick: Report ▸ Get more visuals ▸ **Import from file**.
- Right way: Fabric Admin portal ▸ **Organizational visuals** ▸ upload the .pbiviz. Everyone gets it from "My organization", updates centrally.

## Phase 5 — Verify end-to-end

Slice the report to one region → ask "what's driving the numbers I'm seeing?" → answer should reference only the sliced data. Clear filters → ask again → broader answer. Ask something beyond the bound fields → agent should fall back to Cortex Analyst (watch the status line: "Planning the next steps…").

---

## §6 Design decisions worth knowing

- **Context only on the latest turn.** Older turns are sent context-free to keep token costs sane; the agent re-receives fresh context (post-slicer-change) each question.
- **1000-row dataView window, 200-row prompt cap** (format pane). Bind aggregated fields, not raw fact rows — you want the *story* of the page, not the warehouse.
- **Stateless proxy.** Full message history travels each call. Swap to Snowflake **threads** (`/api/v2/cortex/threads`) later if histories get long.
- **Tool events render, not just text.** `tool_use` → activity trail line; analyst `tool_result` → collapsible "SQL used" block (auditability for BI users); `data_to_chart` results → inline Vega-Lite charts via vega-embed (raw-spec fallback if a spec won't render). Unknown event types are still ignored safely.

## §7 Security: POC → production

| Layer | POC (this scaffold) | Production |
|---|---|---|
| Visual → proxy | Shared key, per-user localStorage | Entra ID JWT. Private visuals **can't** use Power BI's `acquireAADToken` SSO API (AppSource-only), so: `launchUrl()` OAuth popup flow, or publish to AppSource |
| Proxy → Snowflake | One service-user PAT (RBAC = that role for everyone) | **External OAuth security integration with Entra ID**; proxy forwards per-user tokens → Snowflake RBAC + row access policies apply per person |
| Network | Open network policy | Pin Snowflake network policy to Function egress IPs; Function behind APIM if desired |

## §8 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Could not reach proxy" | Proxy URL host not in `WebAccess` parameters (repackage), or CORS — check `ALLOWED_ORIGINS` |
| Works in Desktop, not Service | Tenant blocks uncertified visuals → deploy as organizational visual |
| 401 from proxy | `x-proxy-key` mismatch; re-enter key (it's per-user, per-device) |
| `snowflake_error` 401/403 | PAT expired (90d), network policy blocks Function IP, or role lacks `USAGE` on agent |
| Response never streams, arrives all at once | Hosting plan buffers responses — use Flex Consumption, or accept buffered (it still works) |
| Empty/odd answers | Check the context chip — are the right fields bound? Is the semantic view good? |
| `pbiviz start` cert errors | `npx pbiviz install-cert` once |

## §9 Honest limitations

- This visual can't read *other visuals'* internals — only fields bound to it (filters/slicers still apply globally, which covers most "what am I looking at" intent).
- Certification is impossible by design (certified visuals can't make web calls) — org-visual distribution is the intended path.
- Power BI may unload/reload the visual on page switches; chat history is in-memory per session by design.
- Agent calls time out at 15 min on Snowflake's side; the visual's Send button locks per in-flight question.
