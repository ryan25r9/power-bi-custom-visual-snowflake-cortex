# Phase 1 — Cortex chat with no proxy (M-query round-trip)

A quick-to-demo version of the chat visual that needs **no Azure Function, no CORS,
no web-security wiring — and no Snowflake objects at all**. The trade-off: one
question at a time, no streaming (the answer arrives all at once after a few
minutes), and no conversation memory.

The look is the same as the Phase 2 visual — same bubbles, same context chip — minus
the streaming cursor and the Stop button.

> **Status: not working end-to-end yet.** The model-side plumbing is proven (manual
> tests reach Snowflake and return answers), but the visual's filter is not moving
> the parameter. See [Where debugging stands](#where-debugging-stands) before
> touching anything.

## How it works

The visual never talks to Snowflake. Instead it round-trips through Power BI's own
query engine:

```
1. You type a question.
   The visual builds the prompt (question + the filtered context fields) and
   pushes it as a filter value onto a hidden "binding" column.
        │
        ▼
2. A Dynamic M parameter is bound to that column, so the new value re-runs a
   DirectQuery whose native SQL runs the Cortex agent inline
   (SNOWFLAKE.CORTEX.DATA_AGENT_RUN) and returns the answer as a ROW OF DATA.
        │
        ▼
3. That answer row lands back in the visual's dataView (the "Answer text" role).
   The same visual reads it on its next update() and shows it in a bubble.
```

So the answer comes back as **data**, not an API response. That is the whole trick,
and it's why there's no proxy to secure and nothing to deploy.

## Field notes — things we proved the hard way

These were all hit live against a real tenant. They shape the design below; don't
"fix" them back.

- **`DATA_AGENT_RUN`'s request body must be a constant literal.** Feeding it a
  column or computed expression (`TO_JSON(OBJECT_CONSTRUCT(... p.prompt ...))`)
  fails with `argument ... needs to be constant`. That kills both a stored-proc
  wrapper and a table function (inside either, the prompt is a variable). The
  working pattern: build the entire JSON body **in M** and inline it into the SQL
  as a `$$...$$` literal. This is why Phase 1 creates no Snowflake objects.
- **The ADBC Snowflake connector doesn't honor `?` positional binds** in
  `Value.NativeQuery`. Concatenate the prompt into the query **body** in M instead
  (never into the source line — see Gotchas).
- **A visual's applied filter doesn't filter the visual itself.** `applyJsonFilter`
  has slicer semantics: it filters every *other* visual on the page. The answer has
  to arrive in the chat visual's *own* dataView, so the visual also applies the
  prompt filter at the **`selfFilter`** scope (declared in `capabilities.json`).
- **Agent runs take minutes, not seconds** — 200s observed for a single question.
  The visual's give-up point is the Format-pane **Answer timeout** setting
  (default 600s); a too-short timeout looks exactly like a broken pipeline.
- **`applyJsonFilter` failures are silent.** The returned promise's rejection was
  being dropped; the visual now surfaces any rejection as a muted `⚠ ... filter
  failed` line in the transcript.
- **A visual-applied Basic `In` filter never reached Snowflake** (no query in Query
  History at all), while the **filter pane's Advanced `is` filter on the same
  column works** — and works even though the column is in no field well of the
  filtered visual. The current build therefore emits the Advanced/`Is` shape.
  Unverified as of the last test round — see debugging status.
- Verify the round-trip **in the Power BI Service**, not just Desktop — the
  dynamic-data-source refresh restriction only bites in the Service.

## Where debugging stands

Last updated 2026-07-07, visual build **1.0.3.0** (Advanced/`Is` filter + error
surfacing) built but **not yet tested** in the report.

**Symptom matrix (all verified live):**

| Test | Result |
|---|---|
| Edit `PromptParameter` Current Value manually in Power Query, refresh | **Works.** Agent runs (~200s), real `ANSWER_TEXT` returns |
| Filter pane: drag `PromptBinding[Prompt]` onto a plain table's "Filters on this visual", Advanced filtering, `is`, typed value | **Works.** `DATA_AGENT_RUN` appears in Snowflake Query History. Column is in no field well of that table |
| Click Send in the custom visual (builds ≤ 1.0.2.0, Basic `In` filter) | **Fails.** No query ever appears in Query History — the parameter never moves. Fails even with a 5-character question and report context off |

**Eliminated (don't re-tread):** the 180s timeout (real issue, fixed via the
Answer-timeout setting, but irrelevant here — no query is ever issued); the
"Require user approval for new native database queries" option (off); the
Model-view Bind-to-parameter (verified set); table/column name mismatches; prompt
payload size; the "column must be in the visual's field well" theory (refuted by
the filter-pane test above, which works without it).

**Current hypothesis:** either the Basic-`In`-via-API filter shape doesn't drive
Dynamic M parameter binding the way a pane Advanced-`is` does, or the host is
rejecting the visual's `applyJsonFilter` calls silently. Build 1.0.3.0 tests both
at once: it emits the exact Advanced/`Is` shape the pane used, and prints any
apply-time rejection into the transcript.

**Next actions:** (1) test 1.0.3.0 — watch the transcript for `⚠` lines, Snowflake
Query History (~30s after Send), and a debug table showing `CortexAnswerQuery`'s
columns; (2) if still dead, a fresh-eyes review is queued on why API-applied
filters might not move an M parameter when pane filters do.

## Build it (in order)

### 1. Snowflake access (no objects)

Nothing is created in Snowflake for Phase 1. You only need an identity for the
Power BI dataset connection whose role can run the agent:

- [`../snowflake/grant-existing-agent.sql`](../snowflake/grant-existing-agent.sql)
  sets up the role (`SG_MSU_CORTEX_CHAT_PILOT`) with USAGE on the agent,
  the semantic view, and the agent's warehouse, plus a service user. Shared with
  Phase 2.
- The role also needs `USAGE` on **whatever warehouse the Power BI connection
  itself uses** (`POWERBI_WHS_2` below), which may be a different warehouse than
  the agent's.

Quick validation (run in Snowsight under that role):

```sql
SELECT SNOWFLAKE.CORTEX.DATA_AGENT_RUN(
  'DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA',
  $${"messages":[{"role":"user","content":[{"type":"text","text":"What can you do?"}]}]}$$
) AS raw_response;
```

A JSON blob back = you're clear to build.

### 2. Wire up the Power BI model (the binding plumbing)

This is what turns "the visual changed a filter" into "Snowflake ran the agent and
sent an answer back." It has no UI in the visual — you build it once in Power BI
Desktop. You're building **three objects plus one binding**:

```
PromptParameter     a Text M parameter            -- carries the prompt value
PromptBinding       a tiny disconnected table     -- the visual filters its column
CortexAnswerQuery   a DirectQuery to Snowflake    -- runs the agent with the parameter

   binding:  PromptBinding[Prompt]  ──bound to──►  PromptParameter
```

`PromptBinding` and `CortexAnswerQuery` are **two separate queries**.
`PromptBinding` does **not** connect to Snowflake — it's hand-built, in-memory,
zero rows. The only link between the two is the parameter binding, a one-way value
hand-off. Build them in this order; each step depends on the one before it.

These are the exact definitions of the working model (as validated by the manual
tests in the symptom matrix):

**Step 1 — Create the parameter `PromptParameter`** (Home → Manage Parameters →
New). Everything references it, so it comes first.

- **Type** = Text, **Required** = checked.
- **Suggested Values** = **Any value** (not "List of values" — that would block
  arbitrary prompt text from flowing through).
- **Current Value** = `__no_prompt__`. This is only the design-time default; the
  visual's filter overrides it at runtime. It's a sentinel on purpose: on initial
  load and on every scheduled refresh no question is selected, so the query runs
  with this default — and `CortexAnswerQuery`'s M short-circuits the sentinel to a
  constant `IDLE` row with **zero agent cost** (the agent is never called). Don't
  put a real question here, or every refresh fires a billable agent run.

Resulting M definition:

```m
// Parameter: PromptParameter
"__no_prompt__" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]
```

**Step 2 — Create the binding table `PromptBinding`.** Get Data → **Blank Query**,
open the Advanced Editor, and paste:

```m
// Query name: PromptBinding
let Source = #table(type table [Prompt = text], {}) in Source
```

Leave **Enable load** on so the column lands in the model. It loads as **Import** (a
`#table` can't be DirectQuery — that's fine and expected). Zero rows is deliberate:
the only way the column ever gets a value is a filter, not a row.

**Step 3 — Create the answer query `CortexAnswerQuery`** (DirectQuery). New blank
query, Advanced Editor, paste; when prompted for storage mode, pick **DirectQuery**:

```m
// Query name: CortexAnswerQuery
let
  Source = Snowflake.Databases(
             "msu-prod.east-us-2.privatelink.snowflakecomputing.com",
             "POWERBI_WHS_2",
             [Implementation = "2.0", Role = "SG_MSU_CORTEX_CHAT_PILOT"]),
  Db    = Source{[Name = "DBS_ANALYTICS_AI"]}[Data],

  // Build the JSON body in M (handles all escaping), then inline it as a $$...$$
  // literal. DATA_AGENT_RUN needs a constant body — it rejects a column-derived one.
  Body  = Text.FromBinary(Json.FromValue(
            [ messages = { [ role = "user",
                             content = { [ type = "text", text = PromptParameter ] } ] } ])),

  Sql   =
    if Text.Trim(PromptParameter) = "" or PromptParameter = "__no_prompt__" then
      "SELECT CAST(NULL AS STRING) AS ANSWER_TEXT, CAST(NULL AS STRING) AS GENERATED_SQL, 'IDLE' AS STATUS"
    else
      "WITH resp AS (
         SELECT TRY_PARSE_JSON(
           SNOWFLAKE.CORTEX.DATA_AGENT_RUN(
             'DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.SPARTAN_TRENDS_CA',
             $$" & Body & "$$
           )
         ) AS v
       )
       SELECT
         COALESCE(MAX(CASE WHEN b.value:type::string = 'text'
                           THEN b.value:text::string END),
                  'No answer returned by the agent.') AS ANSWER_TEXT,
         MAX(CASE WHEN b.value:type::string = 'tool_use'
                   AND COALESCE(b.value:tool_use:type::string, b.value:input:type::string)
                       IN ('system_execute_sql','cortex_analyst_text_to_sql')
                  THEN COALESCE(b.value:tool_use:input:sql::string, b.value:input:sql::string) END) AS GENERATED_SQL,
         'OK' AS STATUS
       FROM resp, LATERAL FLATTEN(input => resp.v:content) b",

  Result = Value.NativeQuery(Db, Sql, null, [EnableFolding = true])
in
  Result
```

It returns three columns: `ANSWER_TEXT`, `GENERATED_SQL`, `STATUS`. The parse pulls
the answer out of the agent's JSON by block *type* (never by array position — the
response shape shifts between runs). Your model now mixes Import (`PromptBinding`)
and DirectQuery (`CortexAnswerQuery`) — a composite model, which is exactly what
dynamic M parameters need.

**Step 4 — Bind the column to the parameter.** In **Model view**, select
`PromptBinding[Prompt]` → Properties pane → **Advanced → Bind to parameter** →
choose `PromptParameter`, **Multi-select = No**. The column and parameter must be
the same data type (both Text). This dropdown only appears once the model has a
DirectQuery source — so do it after Step 3. If you don't see it, that's why.

**Step 5 — Sanity check before you touch the visual.** Prove the plumbing: set the
parameter's Current Value to a real question and refresh `CortexAnswerQuery` — you
should get a row with real `ANSWER_TEXT` and `STATUS = OK` (allow several minutes).
Set it back to `__no_prompt__` and refresh — `STATUS = IDLE`, null answer, instant
(no agent call). If both behave, the model works and the visual just drives it from
here.

> **No per-user RLS here.** Power BI row-level security is *not* supported alongside
> dynamic M query parameters, so everyone who opens the report sees answers scoped to
> the one shared role. True per-user security is Phase 3 (Entra passthrough), not
> something RLS bolts onto Phase 1.

### 3. The visual

```bash
cd phase1/visual
npm install
npx pbiviz package        # builds dist/*.pbiviz
```

Import the `.pbiviz`, add it to the page, then:

- Bind your filter dimensions/measures (Region, Year, Category, …) to **Context fields**.
- Bind `CortexAnswerQuery[ANSWER_TEXT]` to **Answer text**.
- In **Format → Cortex Agent**, set **Prompt binding table** / **Prompt binding column**
  to match the names you used (defaults are `PromptBinding` / `Prompt`), and size
  **Answer timeout (seconds)** above your slowest observed agent run (default 600).

Ask a question. The bubble pulses and the status line ticks elapsed seconds while
Snowflake runs, then the bubble fills in with the answer.

Under the hood the visual applies the prompt filter at **two scopes**: `selfFilter`
(so its *own* answer query re-runs — applied filters otherwise skip the applying
visual) and the normal page-scope filter (which reaches other visuals, e.g. a debug
table). Both are declared in `capabilities.json`. Any host rejection of those filter
calls appears as a muted `⚠ ... filter failed` line in the transcript.

## How the pieces map

| Piece                                           | Where                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| Build the prompt + push it as a filter          | `src/visual.ts` → `send()`                      |
| Read the answer back out of the dataView        | `src/contextBuilder.ts` → `readAnswerText()`    |
| Serialize context (excluding the answer column) | `src/contextBuilder.ts` → `buildContextBlock()` |
| Run the agent + parse the response              | the `CortexAnswerQuery` M query (step 2 above)  |
| Binding table / parameter / binding             | the Power BI model (step 2 above)               |

## Gotchas (read before the demo)

- **Native-query approval dialog.** Every new prompt produces a new native query
  string, and Power BI's "Require user approval for new native database queries"
  security option blocks unapproved ones — visibly in the Power Query editor, but
  *silently* when the visual triggers the query. Turn it off: **File → Options and
  settings → Options → Security → uncheck "Require user approval for new native
  database queries."**
- **Dynamic-data-source refresh error (Service-only).** The prompt is concatenated
  into the query **body** in M — that's fine. What must stay static is the
  `Snowflake.Databases(...)` source line: build any part of *it* from a parameter
  and scheduled refresh fails, but only in the Service (Desktop looks fine).
- **DirectQuery only**, **one question at a time**, **no streaming** (a spinner
  stands in), and **no memory** (each question is independent — there's no thread).
- **Every distinct question is a billable agent run.** There's no answer cache (a
  cache table would need Snowflake objects; Phase 1 deliberately creates none).
  Asking the *exact* same question twice in a row may also not produce a new data
  update — change the question or a filter.
- **Charts/tables.** Phase 1 renders text answers (plus the agent's SQL when the
  response includes it). Rich charts/tables were intentionally dropped; that's
  Phase 2 territory.

## If a question times out ("No answer after Ns…")

First, rule out the boring cause: **the agent genuinely takes minutes** (200s+
observed live), and a timeout that's too short looks exactly like a broken
pipeline. The give-up point is **Format > Cortex Agent > Answer timeout**
(default 600s) — size it above your slowest observed run. The status line ticks
elapsed seconds while a question is in flight.

The one observation that settles where the problem is: **Snowflake Query
History**. Click Send, wait ~30s, and look for a new query containing
`DATA_AGENT_RUN` under the connection's role.

- **A query appears** → the whole filter→parameter→Snowflake chain works. If the
  visual still gave up, it's the timeout (raise it), or `ANSWER_TEXT` isn't bound
  to the visual's **Answer text** well.
- **No query appears** → the parameter isn't moving. Check, in order:
  1. Any `⚠ ... filter failed` line in the chat transcript (the host rejected the
     filter — the message says why).
  2. **Native-query approval** (first Gotcha above). Silent blocker; Desktop only
     shows the dialog in the Power Query editor, not in report view.
  3. **Model-view binding**: `PromptBinding[Prompt]` → Advanced → Bind to
     parameter → `PromptParameter`, and the Format-pane binding table/column names
     match the model exactly.
  4. This may be the **open bug** — see [Where debugging stands](#where-debugging-stands).

Note: don't look for the prompt in the Filters pane — filters applied by a visual
behave like slicer selections and never create a filter card. To see it, hover the
funnel icon on another visual ("Filters and slicers affecting this visual"), or
watch for the loading spinner on a debug table showing `CortexAnswerQuery`'s
columns (remembering it won't *finish* until the agent does — minutes, not
seconds).

## Security model

The Snowflake credential lives on the **Power BI dataset connection** (a Service
Principal / PAT), not in the visual and not in a proxy. Everyone shares that one
read-only role (`SG_MSU_CORTEX_CHAT_PILOT`) — no per-user scoping in Phase 1
(see the RLS note above). The role being read-only means a prompt-injection attempt
can't write. Same read-only posture as Phase 2, different plumbing.

## This is a throwaway demo

Phase 1 exists to show value fast while Phase 2 (the proxy + streaming chat) waits on
security and access approvals. When Phase 2 ships, this folder can be deleted. It
deliberately does **not** share code with Phase 2 — it was seeded from the Phase 2
visual and stripped down, so the two can evolve independently without coordination.
