--------------------------------------------------------------------------------
-- Snowflake setup for the Power BI Cortex Chat visual
-- Run as ACCOUNTADMIN (or split per your role model). Edit ALL <placeholders>.
--------------------------------------------------------------------------------

-- 1 ▸ Role + warehouse the agent runs under -----------------------------------
CREATE ROLE IF NOT EXISTS PBI_CORTEX_CHAT_ROLE;
CREATE WAREHOUSE IF NOT EXISTS PBI_CHAT_WH
  WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;
GRANT USAGE ON WAREHOUSE PBI_CHAT_WH TO ROLE PBI_CORTEX_CHAT_ROLE;

-- Cortex entitlement (account-level database role)
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE PBI_CORTEX_CHAT_ROLE;

-- Grant read access to the data your semantic view covers
-- GRANT USAGE ON DATABASE <your_db> TO ROLE PBI_CORTEX_CHAT_ROLE;
-- GRANT USAGE ON SCHEMA <your_db>.<your_schema> TO ROLE PBI_CORTEX_CHAT_ROLE;
-- GRANT SELECT ON ALL TABLES IN SCHEMA <your_db>.<your_schema> TO ROLE PBI_CORTEX_CHAT_ROLE;

-- 2 ▸ Home for the agent --------------------------------------------------------
CREATE DATABASE IF NOT EXISTS AI_DB;
CREATE SCHEMA IF NOT EXISTS AI_DB.AGENTS;
GRANT USAGE ON DATABASE AI_DB TO ROLE PBI_CORTEX_CHAT_ROLE;
GRANT USAGE ON SCHEMA AI_DB.AGENTS TO ROLE PBI_CORTEX_CHAT_ROLE;

-- 3 ▸ Semantic view (the agent's "brain" for structured data) ------------------
-- Prereq: build one over your reporting tables (Snowsight ▸ AI & ML ▸ Studio,
-- or CREATE SEMANTIC VIEW). The better this is, the better the agent's SQL.
-- Docs: https://docs.snowflake.com/en/user-guide/views-semantic/overview

-- 4 ▸ The agent ----------------------------------------------------------------
USE SCHEMA AI_DB.AGENTS;

CREATE OR REPLACE AGENT REPORT_CHAT_AGENT
  COMMENT = 'Answers questions from the Power BI chat visual'
  PROFILE = '{"display_name": "Report Chat Agent"}'
  FROM SPECIFICATION
  $$
  models:
    orchestration: claude-4-sonnet

  orchestration:
    budget:
      seconds: 60
      tokens: 16000

  instructions:
    response: "Be concise. You are embedded in a Power BI report; the user message often begins with a REPORT CONTEXT block describing exactly what the user is looking at (fields, filtered rows, active filters). Ground your answer in that context first; use tools only when the context can't answer the question (e.g. deeper history, different grain)."
    orchestration: "Prefer answering from the provided REPORT CONTEXT. Use Analyst for questions needing data beyond the context window."

  tools:
    - tool_spec:
        # "cortex_analyst_text_to_sql" is still the correct *agent-spec* tool type per
        # current CREATE AGENT docs. Since Apr 2026 the *response stream* emits these
        # blocks as type "system_execute_sql"; the visual parses both.
        type: "cortex_analyst_text_to_sql"
        name: "Analyst1"
        description: "Query the underlying warehouse data when the report context is insufficient"

  tool_resources:
    Analyst1:
      semantic_view: "<your_db>.<your_schema>.<your_semantic_view>"
      execution_environment:
        type: "warehouse"
        warehouse: "PBI_CHAT_WH"
  $$;

GRANT USAGE ON AGENT AI_DB.AGENTS.REPORT_CHAT_AGENT TO ROLE PBI_CORTEX_CHAT_ROLE;

-- 5 ▸ Service user the proxy authenticates as ----------------------------------
CREATE USER IF NOT EXISTS SVC_PBI_CORTEX_CHAT
  TYPE = SERVICE
  DEFAULT_ROLE = PBI_CORTEX_CHAT_ROLE          -- agents run under the DEFAULT role
  DEFAULT_WAREHOUSE = PBI_CHAT_WH              -- and DEFAULT warehouse
  COMMENT = 'Power BI Cortex chat proxy';
GRANT ROLE PBI_CORTEX_CHAT_ROLE TO USER SVC_PBI_CORTEX_CHAT;

-- 6 ▸ Programmatic Access Token (PAT) for the proxy ----------------------------
-- PATs require an authentication policy permitting them, and service users
-- typically need a network policy. Adjust CIDRs to your Function's outbound IPs.
CREATE NETWORK POLICY IF NOT EXISTS PBI_CHAT_PROXY_NP
  ALLOWED_IP_LIST = ('0.0.0.0/0');             -- TIGHTEN to the Function's egress IPs
ALTER USER SVC_PBI_CORTEX_CHAT SET NETWORK_POLICY = PBI_CHAT_PROXY_NP;

ALTER USER SVC_PBI_CORTEX_CHAT
  ADD PROGRAMMATIC ACCESS TOKEN PBI_CHAT_PAT
  ROLE_RESTRICTION = 'PBI_CORTEX_CHAT_ROLE'
  DAYS_TO_EXPIRY = 90;
-- ^ Copy the returned token into the proxy's SNOWFLAKE_PAT app setting NOW;
--   it is shown only once. (Alternative: generate via Snowsight ▸ Admin ▸ Users.)

-- 7 ▸ Smoke test (replace <token>, account URL) --------------------------------
-- curl -N -X POST "https://<org>-<account>.snowflakecomputing.com/api/v2/databases/AI_DB/schemas/AGENTS/agents/REPORT_CHAT_AGENT:run" \
--   -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: text/event-stream" \
--   -d '{"messages":[{"role":"user","content":[{"type":"text","text":"hello, what can you do?"}]}]}'

--------------------------------------------------------------------------------
-- PRODUCTION (per-user identity instead of one service PAT):
-- create an External OAuth security integration trusting Entra ID, map users via
-- login_name, and have the proxy forward each user's token — then Snowflake RBAC
-- and row access policies apply per person. See README §7.
--------------------------------------------------------------------------------
