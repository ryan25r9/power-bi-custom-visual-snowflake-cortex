# Setup guide

This walks you from a fresh clone to a working chat visual in a Power BI report.
You don't need to know TypeScript or touch the source code. You do need to be able
to run commands in a terminal and paste values into config files.

Expect 2-4 hours total, most of it waiting on admins for access and grants.

There are three pieces, set up in this order:

1. **Snowflake** - a service user that's allowed to call the Cortex agent, plus a
   token (PAT) the proxy will authenticate with.
2. **The proxy** - a small Azure Function. It holds the Snowflake token, adds CORS
   headers so a browser can call it, and relays the agent's streaming response.
   The token never reaches Power BI or the browser.
3. **The visual** - the `.pbiviz` file you import into Power BI. It has to be built
   once on your machine because the allowed proxy URL is baked in at build time.

```
Power BI report  ──►  Azure Function proxy  ──►  Snowflake Cortex agent
(chat visual)         (holds the token)          (SPARTAN_TRENDS_CA)
```

## Before you start

| You need | Who to ask |
|---|---|
| A Snowflake admin who can create a service user and grant access to the agent | The agent owner. For `SPARTAN_TRENDS_CA` that's the `SG_MSU_CORTEX_SUPPORT_TEAM` group |
| An Azure subscription where you can create a resource group and a Function App | Your cloud / infrastructure team |
| Power BI rights to import a visual into a report. For company-wide rollout: a Fabric tenant admin | BI platform team |
| A laptop with Node.js 20+, the Azure CLI (`az`), and Azure Functions Core Tools v4 (`npm i -g azure-functions-core-tools@4`) | - |

Check the Power BI tenant doesn't block SDK visuals: Fabric Admin portal >
Tenant settings > "Visuals created by the Power BI SDK". If it's blocked, the
visual will work in Desktop but not in the Service.

## Part 1 - Snowflake

The agent already exists (`SPARTAN_TRENDS_CA` in `DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI`),
so you only need a service user wired up to it. Send
[`snowflake/grant-existing-agent.sql`](snowflake/grant-existing-agent.sql) to your
Snowflake admin - it's pre-filled with the right names and creates:

- a role with USAGE on the agent, the semantic view, and the warehouse
- a service user (`SVC_PBI_CORTEX_CHAT`) with that role and warehouse as defaults
- a network policy and a programmatic access token (PAT)

Things to know about the PAT:

- It's printed **once** when created. Whoever runs the script must copy it
  immediately and hand it to you through a secure channel (not email).
- It expires in 90 days by default. Put a reminder somewhere to rotate it.
- There's also a UI for it: Snowsight > Governance & security > Users & roles >
  select the user > Programmatic access tokens > Generate new token. For a
  service user the role restriction is required; set it to `PBI_CORTEX_CHAT_ROLE`.
- For a quick personal test before the service user exists, you can generate a
  PAT for your own user the same way (set the role restriction to the role you
  use to access the agent). Using a PAT requires your user to be under a network
  policy, so run the smoke test from the corporate network/VPN. Don't deploy the
  proxy with a personal token; it carries your access and your expiry.

(If you ever need to stand up an agent from nothing, that's what
[`snowflake/setup.sql`](snowflake/setup.sql) is for. Skip it here.)

**Smoke test.** Before going any further, prove the token works from your laptop:

Replace `<THE_PAT>` with the actual token (keep no angle brackets), then run:

```bash
curl -N -X POST "https://msu-prod.snowflakecomputing.com/api/v2/databases/DBS_ANALYTICS_AI/schemas/SPARTAN_TRENDS_AI/agents/SPARTAN_TRENDS_CA:run" \
  -H "Authorization: Bearer <THE_PAT>" \
  -H "X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello, what can you do?"}]}]}'
```

The token-type header matters: without it, Snowflake guesses what kind of token you
sent, and a wrong guess comes back as `390303 Invalid OAuth access token` even when
the real problem is something else.

You should see lines like `event: response.status` and `event: response.text.delta`
stream back over a few seconds. If the hostname doesn't resolve, swap the host for
the regional URL (`msu.east-us-2.azure.snowflakecomputing.com`) and keep the rest
of the path exactly the same. Whichever host works here is the one you'll use as
`SNOWFLAKE_ACCOUNT_URL` in Part 2. Note: any JSON error response means the host is
fine and you're debugging auth, not connectivity.

Common failures at this step:

| Response | Meaning |
|---|---|
| 390303 "Invalid OAuth access token" | The token string is wrong (placeholder left in, partial copy, expired/revoked PAT), or the token-type header above is missing |
| 399513 "agent does not exist or access is not authorized for the current role" | Auth worked; the session's role can't see the agent. PAT sessions run under the token's role restriction, or the user's DEFAULT_ROLE if none was set. Regenerate the token with the role restriction set to a role that has USAGE on the database, the schema, and the agent (restrictions can't be edited after creation) |
| 401 invalid token | PAT copied wrong, expired, or the user's network policy blocks your IP |
| 403 | The service user's role is missing USAGE on the agent |
| 404 | Database/schema/agent name typo in the URL |

Don't continue until this curl streams. Everything downstream depends on it.

## Part 2 - The proxy

Open [`deploy.sh`](deploy.sh) and fill in the `EDIT THESE` block at the top.
The Snowflake values, resource group (`rg-pbi-cortex-chat`), app name
(`pbi-cortex-chat-proxy`), and storage account are already filled in; the one
value you must supply is the PAT from Part 1. If you change the app name, it has
to stay a valid hostname (lowercase letters, digits, hyphens) because it becomes
`<name>.azurewebsites.net`, and you'll need to change it in Part 3 step 1 too.
Then:

```bash
az login
./deploy.sh
```

The script creates the resource group and Function App, sets the app settings,
builds the proxy, and publishes it. At the end it prints two values - save both:

- the **proxy URL** (`https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent`)
- the **access key** (a random string it generated; report users will paste this
  into the visual once)

Smoke test the deployed proxy (the script prints this command too):

```bash
curl -N -X POST https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent \
  -H "Content-Type: application/json" -H "x-proxy-key: <the access key>" \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}'
```

Same expectation: `event:` lines streaming back.

Afterwards, ask the Snowflake admin to tighten the network policy from
`0.0.0.0/0` to the Function's outbound IPs. This command lists them:

```bash
az functionapp show -g rg-pbi-cortex-chat -n pbi-cortex-chat-proxy --query outboundIpAddresses
```

To run the proxy locally instead of (or before) deploying: `cd proxy`,
`cp local.settings.json.example local.settings.json`, fill in the values,
`npm install && npm start`. It serves `http://localhost:7071/api/agent`.

## Part 3 - The visual

The visual must be built once because Power BI only lets a visual call hosts
declared inside the package.

1. Open [`visual/capabilities.json`](visual/capabilities.json) and check the
   `privileges` section. It's already set to the deployed proxy host (origin only,
   no `/api/agent` path) - confirm it matches the name you used in `deploy.sh`:

   ```json
   "privileges": [
     { "name": "WebAccess", "essential": true,
       "parameters": ["https://pbi-cortex-chat-proxy.azurewebsites.net"] }
   ]
   ```

   If you changed the app name, edit this string to match, or the visual won't be
   allowed to call the proxy.

2. Build the package:

   ```bash
   cd visual
   npm install
   npx pbiviz package
   ```

   This writes `visual/dist/snowflakeCortexChat....pbiviz`. (First-time tooling
   hiccups: if it complains about certificates, run `npx pbiviz install-cert` once.)

3. Import it into a report. Two options:
   - Just you / testing: in the report, Visualizations pane > "..." >
     **Import a visual from a file** > pick the `.pbiviz`.
   - Whole org: Fabric Admin portal > **Organizational visuals** > upload. Everyone
     then adds it from "My organization", and updates are centralized. This is also
     the fix if the tenant blocks unsigned visuals from files.

4. Add the visual to a page and configure it (select it, then the **Format** pane >
   **Cortex Agent** card):
   - **Proxy URL**: `https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent` (the
     full URL with the path this time)
   - **Report description** (optional but recommended): one sentence about what the
     page shows, e.g. "Dining spend and usage trends by category". The agent
     reads this with every question.

5. Bind data. Drag the page's important dimensions and measures into the visual's
   **Context fields** well. This is what the agent can "see" - the chip in the
   visual's header shows it live, e.g. `context: 5 fields · 312 rows`. Bind
   aggregated fields rather than raw transaction rows; the prompt only carries the
   first 200 rows (adjustable in the Format pane).

6. Ask a question. The first time, the visual asks for the **access key** - paste
   the one `deploy.sh` printed. It's stored per user in browser storage, never in
   the report file, so each user enters it once.

## Part 4 - Prove it works

Run through this list before handing the report to anyone:

- [ ] Ask "what am I looking at?" - the answer should describe the bound fields.
- [ ] Set a slicer to one category, ask "what's driving these numbers?" - the
      answer should reference only the filtered data. The context chip row count
      should drop when you slice.
- [ ] Ask something the bound fields can't answer (different time range, different
      grain). You should see a tool-activity line appear ("Querying data") and a
      collapsible "SQL used" block - that's the agent querying the semantic view
      directly, and the SQL is there for auditing.
- [ ] While an answer is streaming, click **Stop**. The stream should halt cleanly.
- [ ] Open the report as a second user (or a private browser session). The visual
      should ask that user for the access key once, then work.

If any of these fail, the troubleshooting table in the [README](README.md#troubleshooting)
maps symptoms to causes.

## Later: production hardening

The shared access key is fine for a pilot. Before a broad rollout, read the
security section of the [README](README.md#security-model) - the short version:

- move `SNOWFLAKE_PAT` into a Key Vault reference on the Function App
- pin the Snowflake network policy to the Function's egress IPs (do this now, it's cheap)
- the long-term auth upgrade is Entra ID tokens end to end, so Snowflake row-level
  security applies per person instead of everyone sharing the service user's access
