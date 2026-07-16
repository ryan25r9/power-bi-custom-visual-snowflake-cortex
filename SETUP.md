# Setup guide

This is the deployment runbook: Snowflake service user → Azure Function proxy →
Power BI visual, in that order. You don't need to know TypeScript or open the
source. You do need to run a few terminal commands and paste values into config
files.

> **Before you spend an hour here:** read
> [ARCHITECTURE.md → Networking](ARCHITECTURE.md#networking-read-before-deploying).
> If the Snowflake account is PrivateLink-only, a default public Azure Function
> cannot reach it and Part 2 will fail with timeouts that look like auth errors.
> Settle the networking question with the cloud team first.

Budget 2-4 hours of hands-on time, plus lead time waiting on Snowflake, Azure, and
Power BI admins for access.

## What you're building

Three pieces, set up in this order. Each one is proven working before you start the
next, so a failure is easy to place.

```
Power BI report  ──►  Azure Function proxy  ──►  Snowflake Cortex agent
(chat visual)         (holds the token)          (SPARTAN_TRENDS_CA)
```

1. **Snowflake** - a service user allowed to call the agent, plus a token (PAT).
2. **The proxy** - a small Azure Function. It holds the Snowflake token, adds the
   CORS headers a browser needs, and relays the streamed answer. The token never
   reaches Power BI or the browser.
3. **The visual** - the `.pbiviz` you import into Power BI. You build it once on your
   machine because the allowed proxy host is baked into the package at build time.

## Before you start

| You need | Who to ask |
|---|---|
| A Snowflake admin who can create a service user and grant access to the agent | The agent owner - for `SPARTAN_TRENDS_CA` that's `SG_MSU_CORTEX_SUPPORT_TEAM` |
| An Azure subscription where you can create a resource group + Function App | Your cloud / infrastructure team |
| Power BI rights to import a visual. For an org-wide rollout: a Fabric tenant admin | BI platform team |
| A laptop with Node.js 20+, the Azure CLI (`az`), and Azure Functions Core Tools v4 (`npm i -g azure-functions-core-tools@4`) | - |

One tenant check before you sink time in: Fabric Admin portal > Tenant settings >
**"Visuals created by the Power BI SDK"** must be allowed. If it's blocked, the visual
runs in Desktop but not in the Service, and you'll distribute it as an organizational
visual (Part 3).

## Part 1 - Snowflake

The agent already exists (`SPARTAN_TRENDS_CA` in `DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI`),
so you only wire a service user to it. Send
[`snowflake/grant-existing-agent.sql`](snowflake/grant-existing-agent.sql) to your
Snowflake admin. It's pre-filled with the right names and creates:

- a read-only role with USAGE on the agent, the semantic view, and the warehouse
- a service user (`SVC_PBI_CORTEX_CHAT`) with that role and warehouse as its defaults
- a network policy and a programmatic access token (PAT)

(Standing up an agent from scratch instead? That's
[`snowflake/setup.sql`](snowflake/setup.sql). Skip it here.)

**About the PAT:**

- It prints **once**, when the script runs. Whoever runs it copies it immediately and
  hands it to you over a secure channel (not email). It expires in 90 days - set a
  reminder to rotate it.
- Prefer a UI? Snowsight > Governance & security > Users & roles > select the user >
  Programmatic access tokens > Generate. For a service user the role restriction is
  required; set it to `SG_MSU_CORTEX_CHAT_PILOT`.
- Want to test before the service user exists? Generate a PAT for your own user the
  same way, with the role restriction set to a role that can reach the agent. PATs
  require the user to be under a network policy, so run the smoke test from the
  corporate network or VPN. Don't deploy the proxy with a personal token - it carries
  your access and your expiry.

**Smoke test.** Prove the token works from your laptop before anything else. Replace
`<THE_PAT>` (no angle brackets) and run:

```bash
curl -N -X POST "https://msu-prod.snowflakecomputing.com/api/v2/databases/DBS_ANALYTICS_AI/schemas/SPARTAN_TRENDS_AI/agents/SPARTAN_TRENDS_CA:run" \
  -H "Authorization: Bearer <THE_PAT>" \
  -H "X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello, what can you do?"}]}]}'
```

Success looks like `event: response.status` and `event: response.text.delta` lines
streaming back over a few seconds.

Two things that trip people up here:

- **The token-type header is not optional.** Without
  `X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN`, Snowflake guesses
  the token kind and a wrong guess comes back as `390303 Invalid OAuth access token` -
  which sends you debugging the wrong thing.
- **Host vs. auth.** If the hostname doesn't resolve at all, swap it for the regional
  URL (`msu.east-us-2.azure.snowflakecomputing.com`) and keep the rest of the path
  identical. Any *JSON error* response means the host is fine and you're debugging
  auth, not connectivity. Whichever host works here is your `SNOWFLAKE_ACCOUNT_URL` in
  Part 2.

If it doesn't stream, match the response to the cause:

| Response | Cause |
|---|---|
| `390303` "Invalid OAuth access token" | Token string wrong (placeholder left in, partial copy, expired/revoked), or the token-type header is missing |
| `399513` "agent does not exist or access is not authorized..." | Auth worked, but the session's role can't see the agent. PAT sessions run under the token's role restriction (or the user's DEFAULT_ROLE if none). Regenerate with the restriction set to a role that has USAGE on the database, schema, and agent - restrictions can't be edited after creation |
| `401` invalid token | PAT copied wrong, expired, or the network policy blocks your IP |
| `403` | The role is missing USAGE on the agent |
| `404` | Database / schema / agent name typo in the URL |

Don't continue until this curl streams. Everything downstream depends on it.

## Part 2 - The proxy

Open [`deploy.sh`](deploy.sh) and fill in the `EDIT THESE` block. The Snowflake
values, resource group (`rg-pbi-cortex-chat`), app name (`pbi-cortex-chat-proxy`), and
storage account are already set - the one value you must add is the PAT from Part 1. If
you rename the app, keep it a valid hostname (lowercase letters, digits, hyphens),
because it becomes `<name>.azurewebsites.net`, and update it in Part 3 too.

```bash
az login
./deploy.sh
```

The script creates the resource group and Function App, sets the app settings, builds
the proxy, and publishes it. At the end it prints two things - **save both**:

- the **proxy URL**: `https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent`
- the **access key**: a random string it generated; report users paste this into the
  visual once

Smoke test the deployed proxy (the script prints this command too):

```bash
curl -N -X POST https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent \
  -H "Content-Type: application/json" -H "x-proxy-key: <the access key>" \
  -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}]}'
```

Same expectation: `event:` lines streaming back. Then ask the Snowflake admin to
tighten the network policy from `0.0.0.0/0` to the Function's outbound IPs:

```bash
az functionapp show -g rg-pbi-cortex-chat -n pbi-cortex-chat-proxy --query outboundIpAddresses
```

Prefer to run the proxy locally first? `cd proxy`, `cp local.settings.json.example
local.settings.json`, fill in the values, `npm install && npm start`. It serves
`http://localhost:7071/api/agent`.

## Part 3 - The visual

You build the visual once, because Power BI only lets a visual call hosts that are
declared inside its package.

**1. Point the package at your proxy host.** Open
[`visual/capabilities.json`](visual/capabilities.json) and confirm the `WebAccess`
privilege matches the app name you used (origin only, no `/api/agent` path):

```json
"privileges": [
  { "name": "WebAccess", "essential": true,
    "parameters": ["https://pbi-cortex-chat-proxy.azurewebsites.net"] }
]
```

If you renamed the app in `deploy.sh`, change this string to match or the visual can't
reach the proxy.

**2. Build it.**

```bash
cd visual
npm install
npx pbiviz package      # writes visual/dist/snowflakeCortexChat....pbiviz
```

If the tooling complains about certificates, run `npx pbiviz install-cert` once and
re-run.

**3. Import it.**

- Just you / testing: in the report, Visualizations pane > "..." > **Import a visual
  from a file** > pick the `.pbiviz`.
- Org-wide: Fabric Admin portal > **Organizational visuals** > upload. Everyone adds it
  from "My organization" and updates are centralized. This is also the path if the
  tenant blocks visuals imported from a file.

**4. Configure it.** Add the visual to a page, select it, then **Format pane > Cortex
Agent**:

- **Proxy URL**: `https://pbi-cortex-chat-proxy.azurewebsites.net/api/agent` (the full
  URL with the path this time)
- **Report description** (optional, recommended): one sentence on what the page shows,
  e.g. "Dining spend and usage trends by category". The agent reads it with every
  question.

**5. Bind the context.** Drag the page's key dimensions and measures into the
**Context fields** well - that's what the agent can see. The header chip shows it live
(`context: 5 fields · 312 rows`). Bind aggregated fields, not raw transaction rows; the
prompt carries only the first 200 rows (adjustable in the Format pane).

**6. Ask a question.** The first time, the visual asks for the **access key** - paste
the one `deploy.sh` printed. It's stored per user in browser storage, never in the
report file, so each person enters it once.

## Part 4 - Prove it works

Run this before handing the report to anyone:

- [ ] Ask "what am I looking at?" - the answer describes the bound fields.
- [ ] Slice to one category, ask "what's driving these numbers?" - the answer reflects
      only the filtered data, and the context chip's row count drops.
- [ ] Ask something the bound fields can't answer (a different time range or grain). A
      "Querying data" activity line and a collapsible "SQL used" block should appear -
      the agent is querying the semantic view directly, and the SQL is there to audit.
- [ ] While an answer streams, click **Stop**. The stream halts cleanly.
- [ ] Open the report as a second user (or a private window). It asks that user for the
      access key once, then works.

If any of these fail, the [README troubleshooting table](README.md#troubleshooting)
maps symptoms to causes.

## Later: production hardening

The shared access key is fine for a pilot. Before a broad rollout, read the
[security model](README.md#security-model) in the README. The short list:

- move `SNOWFLAKE_PAT` into a Key Vault reference on the Function App
- pin the Snowflake network policy to the Function's egress IPs (do this now - it's cheap)
- the long-term auth upgrade is Entra ID tokens end to end (Phase 3), so Snowflake
  row-level security applies per person instead of everyone sharing the service user's
  access
