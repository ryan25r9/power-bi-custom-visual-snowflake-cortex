--------------------------------------------------------------------------------
-- Wire a service user to an EXISTING Cortex agent.
--
-- Use this when the agent is already built and you just need the Azure Function
-- proxy to be able to call it. (If you need to create an agent from nothing,
-- use setup.sql instead.)
--
-- Pre-filled for the MSU spartan-trends agent:
--   agent:          DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA
--   semantic view:  DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_SV
--   warehouse:      WHS_SPARTAN_TRENDS_AGENT
-- Change those names if you're wiring up a different agent.
--
-- Who runs this: someone who can create users/roles and grant on the agent.
-- The agent is owned by SG_MSU_CORTEX_SUPPORT_TEAM, so that team (or ACCOUNTADMIN)
-- is the right audience. Send them this file.
--------------------------------------------------------------------------------

-- 1. A dedicated role for the proxy's service user.
--    Keep this role read-only: the chat visual sends report data to the agent,
--    and the agent runs SQL as this role. A write-capable role here would let a
--    prompt-injection attempt do real damage; a read-only one can't.
CREATE ROLE IF NOT EXISTS PBI_CORTEX_CHAT_ROLE;

-- Cortex entitlement (account-level database role; required to call any
-- Cortex feature, including agents).
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE PBI_CORTEX_CHAT_ROLE;

-- 2. Access to the agent and everything it touches at query time.
GRANT USAGE ON DATABASE DBS_ANALYTICS_AI TO ROLE PBI_CORTEX_CHAT_ROLE;
GRANT USAGE ON SCHEMA DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI TO ROLE PBI_CORTEX_CHAT_ROLE;
GRANT USAGE ON AGENT DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA TO ROLE PBI_CORTEX_CHAT_ROLE;
GRANT REFERENCES, SELECT ON SEMANTIC VIEW DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_SV TO ROLE PBI_CORTEX_CHAT_ROLE;
GRANT USAGE ON WAREHOUSE WHS_SPARTAN_TRENDS_AGENT TO ROLE PBI_CORTEX_CHAT_ROLE;
-- If agent queries later fail with "not authorized" on underlying tables, the
-- role may also need read access to the schema the semantic view sits on top
-- of. Ask the data owner; don't grant more than SELECT.

-- 3. The service user the proxy authenticates as.
--    Agents run under the calling user's DEFAULT role and DEFAULT warehouse,
--    which is why both defaults are set here rather than left to chance.
CREATE USER IF NOT EXISTS SVC_PBI_CORTEX_CHAT
  TYPE = SERVICE
  DEFAULT_ROLE = PBI_CORTEX_CHAT_ROLE
  DEFAULT_WAREHOUSE = WHS_SPARTAN_TRENDS_AGENT
  COMMENT = 'Power BI Cortex chat proxy (Azure Function)';
GRANT ROLE PBI_CORTEX_CHAT_ROLE TO USER SVC_PBI_CORTEX_CHAT;

-- 4. Network policy. Service users generally must have one before a PAT will
--    work. 0.0.0.0/0 gets you through initial testing; tighten it to the Azure
--    Function's outbound IPs once the proxy is deployed (deploy.sh prints the
--    command that lists them).
CREATE NETWORK POLICY IF NOT EXISTS PBI_CHAT_PROXY_NP
  ALLOWED_IP_LIST = ('0.0.0.0/0');
ALTER USER SVC_PBI_CORTEX_CHAT SET NETWORK_POLICY = PBI_CHAT_PROXY_NP;

-- 5. The programmatic access token (PAT) the proxy uses to authenticate.
--    IMPORTANT: the token is displayed ONCE, right here, when this statement
--    runs. Copy it immediately and pass it to whoever is deploying the proxy
--    through a secure channel. It becomes the SNOWFLAKE_PAT app setting.
--    It expires after 90 days; rotating it = rerun this with a new name.
ALTER USER SVC_PBI_CORTEX_CHAT
  ADD PROGRAMMATIC ACCESS TOKEN PBI_CHAT_PAT
  ROLE_RESTRICTION = 'PBI_CORTEX_CHAT_ROLE'
  DAYS_TO_EXPIRY = 90;
-- If this errors about authentication policy: the account's authentication
-- policy must permit PATs for service users. Snowsight > Admin > Users also
-- has a UI for generating PATs if that's easier.

-- 6. Smoke test (run from any terminal, not Snowsight). Replace <PAT>.
--    You should see "event: response.status" / "response.text.delta" lines
--    stream back. SETUP.md Part 1 explains what failures here mean.
-- curl -N -X POST "https://msu-prod.snowflakecomputing.com/api/v2/databases/DBS_ANALYTICS_AI/schemas/SPARTAN_TRENDS_AI/agents/SPARTAN_TRENDS_CA:run" \
--   -H "Authorization: Bearer <PAT>" \
--   -H "X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN" \
--   -H "Content-Type: application/json" -H "Accept: text/event-stream" \
--   -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello, what can you do?"}]}]}'
