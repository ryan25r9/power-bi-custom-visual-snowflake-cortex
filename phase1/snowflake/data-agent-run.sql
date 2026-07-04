--------------------------------------------------------------------------------
-- Phase 1 — run the Cortex agent from inside Snowflake SQL.
--
-- This is what the Power BI model/query layer CALLs. There is NO Azure Function
-- in Phase 1: the visual writes the prompt into a Dynamic M parameter, Power BI
-- re-runs a DirectQuery that CALLs the procedure below, and the answer comes back
-- as a row of data.
--
-- PREREQUISITE: run ../../snowflake/grant-existing-agent.sql first. It creates
-- SG_MSU_CORTEX_CHAT_PILOT and grants it USAGE on the agent + semantic view +
-- warehouse, and creates the service user/PAT. This file only adds the wrapper
-- procedure, the answer cache, and their grants.
--
-- Pre-filled for the MSU spartan-trends agent
-- (DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA). Who runs this: someone
-- who can CREATE PROCEDURE / TABLE in that schema (e.g. SG_MSU_CORTEX_SUPPORT_TEAM).
--------------------------------------------------------------------------------

USE SCHEMA DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI;

-- 0. VALIDATE THE CALLABLE FIRST (Spike 2 — do this before anything else).
--    Confirm the agent runs from SQL under the proxy role. You should get a JSON
--    object back whose content[] has a block with "type":"text".
--
--    USE ROLE SG_MSU_CORTEX_CHAT_PILOT;
--    USE WAREHOUSE WHS_SPARTAN_TRENDS_AGENT;
--    SELECT TRY_PARSE_JSON(
--      SNOWFLAKE.CORTEX.DATA_AGENT_RUN(
--        'DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA',
--        $${"messages":[{"role":"user","content":[{"type":"text","text":"What can you do?"}]}]}$$
--      )
--    ) AS resp;
--
--    If this errors, fix grants / cross-region inference before continuing.

-- 1. Answer cache --------------------------------------------------------------
-- Agent runs are non-deterministic and are NOT served from Snowflake's result
-- cache, so identical questions would re-pay tokens + warehouse time on every
-- report refresh. This table short-circuits that: the proc checks it first and
-- only calls the agent on a miss. Keyed by a hash of the full prompt (question +
-- serialized context), so a different filter context is correctly a cache miss.
CREATE TABLE IF NOT EXISTS AGENT_ANSWER_CACHE (
  PROMPT_HASH    STRING        NOT NULL,            -- SHA2(prompt, 256)
  PROMPT         STRING,                            -- kept for debugging / audit
  ANSWER_TEXT    STRING,
  GENERATED_SQL  STRING,
  STATUS         STRING,
  CREATED_AT     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Optional housekeeping: keep the cache from growing without bound.
-- CREATE TASK PURGE_AGENT_ANSWER_CACHE WAREHOUSE = WHS_SPARTAN_TRENDS_AGENT
--   SCHEDULE = 'USING CRON 0 3 * * * America/Chicago'
--   AS DELETE FROM AGENT_ANSWER_CACHE WHERE CREATED_AT < DATEADD('day', -7, CURRENT_TIMESTAMP());

-- 2. The wrapper procedure -----------------------------------------------------
-- EXECUTE AS CALLER is REQUIRED and non-negotiable: a Cortex agent runs under the
-- CALLER's default role and warehouse. Owner's-rights agent execution is not
-- supported and fails (often silently). So the identity that CALLs this (the
-- Power BI dataset connection — see grants in step 3) must itself hold the full
-- agent-run grant chain, which grant-existing-agent.sql already gives
-- SG_MSU_CORTEX_CHAT_PILOT.
CREATE OR REPLACE PROCEDURE DATA_AGENT_RUN(PROMPT STRING)
  RETURNS TABLE (ANSWER_TEXT STRING, GENERATED_SQL STRING, STATUS STRING)
  LANGUAGE SQL
  EXECUTE AS CALLER
AS
$$
DECLARE
  prompt_hash   STRING;
  hit_count     INT;
  resp          VARIANT;
  answer_text   STRING;
  generated_sql STRING;
  err_msg       STRING;
  status        STRING;
  out_rs        RESULTSET;
BEGIN
  -- 2a. Idle guard. On initial report load and on every scheduled refresh, no
  --     filter is selected yet, so the query runs with the M parameter's default
  --     ('__no_prompt__' — see phase1/README.md). Skip the agent entirely so we
  --     don't pay for a run on a non-question. Return no answer (STATUS 'IDLE').
  IF (TRIM(:PROMPT) = '' OR :PROMPT = '__no_prompt__') THEN
    out_rs := (SELECT NULL::STRING AS ANSWER_TEXT, NULL::STRING AS GENERATED_SQL, 'IDLE' AS STATUS);
    RETURN TABLE(out_rs);
  END IF;

  prompt_hash := SHA2(:PROMPT, 256);

  -- 2b. Cache lookup (24h TTL — tune with the data owner; a daily-refresh
  --     dataset can run hotter). On a hit, return immediately, zero agent cost.
  SELECT COUNT(*) INTO :hit_count
  FROM AGENT_ANSWER_CACHE
  WHERE PROMPT_HASH = :prompt_hash
    AND CREATED_AT > DATEADD('hour', -24, CURRENT_TIMESTAMP());

  IF (hit_count > 0) THEN
    out_rs := (
      SELECT ANSWER_TEXT, GENERATED_SQL, 'CACHED' AS STATUS
      FROM AGENT_ANSWER_CACHE
      WHERE PROMPT_HASH = :prompt_hash
        AND CREATED_AT > DATEADD('hour', -24, CURRENT_TIMESTAMP())
      ORDER BY CREATED_AT DESC
      LIMIT 1
    );
    RETURN TABLE(out_rs);
  END IF;

  -- 2c. Run the agent. Build the request body with OBJECT_CONSTRUCT so the prompt
  --     is a JSON *value*, never concatenated into SQL text — the real injection
  --     guard. (The visual sends the prompt as a bound parameter; this is the
  --     server-side belt-and-suspenders.)
  resp := TRY_PARSE_JSON(
    SNOWFLAKE.CORTEX.DATA_AGENT_RUN(
      'DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA',
      TO_JSON(OBJECT_CONSTRUCT(
        'messages', ARRAY_CONSTRUCT(
          OBJECT_CONSTRUCT(
            'role', 'user',
            'content', ARRAY_CONSTRUCT(
              OBJECT_CONSTRUCT('type', 'text', 'text', :PROMPT)
            )
          )
        )
      ))
    )
  );

  -- 2d. Parse by content TYPE via LATERAL FLATTEN — NEVER index-based
  --     (content[2]:text): the block order shifts between runs. We pull the text
  --     block (the answer), the SQL the agent ran (system_execute_sql, or the
  --     legacy cortex_analyst_text_to_sql), and any error block.
  SELECT
    MAX(CASE WHEN block:type::string = 'text' THEN block:text::string END),
    MAX(CASE WHEN block:type::string = 'tool_use'
              AND COALESCE(block:tool_use:type::string, block:input:type::string)
                  IN ('system_execute_sql', 'cortex_analyst_text_to_sql')
             THEN COALESCE(block:tool_use:input:sql::string, block:input:sql::string) END),
    MAX(CASE WHEN block:type::string = 'error' OR block:status::string = 'error'
             THEN block:error:message::string END)
  INTO :answer_text, :generated_sql, :err_msg
  FROM (SELECT f.value AS block FROM TABLE(FLATTEN(input => :resp:content)) f);

  -- 2e. Derive status; fall back cleanly when there's no text answer.
  IF (answer_text IS NOT NULL) THEN
    status := 'OK';
  ELSEIF (err_msg IS NOT NULL) THEN
    status := 'AGENT_ERROR';
    answer_text := err_msg;
  ELSE
    status := 'EMPTY';
    answer_text := 'No answer returned by the agent.';
  END IF;

  -- 2f. Write-through to the cache on a clean answer only.
  IF (status = 'OK') THEN
    INSERT INTO AGENT_ANSWER_CACHE (PROMPT_HASH, PROMPT, ANSWER_TEXT, GENERATED_SQL, STATUS)
    VALUES (:prompt_hash, :PROMPT, :answer_text, :generated_sql, :status);
  END IF;

  out_rs := (SELECT :answer_text AS ANSWER_TEXT, :generated_sql AS GENERATED_SQL, :status AS STATUS);
  RETURN TABLE(out_rs);

EXCEPTION
  WHEN OTHER THEN
    out_rs := (SELECT SQLERRM::STRING AS ANSWER_TEXT, NULL::STRING AS GENERATED_SQL, 'PROC_ERROR' AS STATUS);
    RETURN TABLE(out_rs);
END;
$$;

-- 3. Grants delta (beyond grant-existing-agent.sql) ----------------------------
-- The proc runs with caller's rights, so the CALLER needs read/write on the cache
-- and EXECUTE on the proc. The caller is the Power BI dataset's Snowflake
-- connection identity — point that connection at a Service Principal / PAT whose
-- DEFAULT ROLE is SG_MSU_CORTEX_CHAT_PILOT (it already has the agent-run chain).
GRANT SELECT, INSERT, DELETE ON TABLE AGENT_ANSWER_CACHE TO ROLE SG_MSU_CORTEX_CHAT_PILOT;
GRANT USAGE ON PROCEDURE DATA_AGENT_RUN(STRING)        TO ROLE SG_MSU_CORTEX_CHAT_PILOT;

-- 4. Smoke test the proc (run as the caller role) ------------------------------
-- USE ROLE SG_MSU_CORTEX_CHAT_PILOT;
-- USE WAREHOUSE WHS_SPARTAN_TRENDS_AGENT;
-- CALL DATA_AGENT_RUN('What were the top dining categories by spend last quarter?');
-- Run it again immediately — the second call should return STATUS = 'CACHED'.

--------------------------------------------------------------------------------
-- POWER BI SIDE (summary — full walkthrough in phase1/README.md):
--   * Create a disconnected, zero-row table `PromptBinding[Prompt]` (text).
--   * Create a Text M parameter `PromptParameter`; bind PromptBinding[Prompt] to
--     it (Model view > Advanced > Bind to parameter, Multi-select = No).
--   * The DirectQuery answer query CALLs this proc with the parameter as a BOUND
--     value, never string-concatenated, so the Service doesn't flag a "dynamic
--     data source" and scheduled refresh keeps working:
--
--       let
--         Source = Snowflake.Databases("msu-prod.snowflakecomputing.com",
--                                       "WHS_SPARTAN_TRENDS_AGENT"),
--         Db     = Source{[Name="DBS_ANALYTICS_AI"]}[Data],
--         Result = Value.NativeQuery(
--                    Db,
--                    "CALL DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.DATA_AGENT_RUN(?)",
--                    { PromptParameter },
--                    [EnableFolding = true])
--       in Result
--
--   * Map the returned ANSWER_TEXT column into the visual's "Answer text" role.
--------------------------------------------------------------------------------
