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
1. You type a question into the INPUT instance of the visual.
   It builds the prompt and applies it as a filter value onto a hidden
   "binding" column. (A visual's filter only ever reaches OTHER visuals —
   slicer semantics — which is why sending and displaying are two instances.)
        │
        ▼
2. A Dynamic M parameter is bound to that column, so the new value re-runs the
   DISPLAY instance's DirectQuery, whose native SQL runs the Cortex agent inline
   (SNOWFLAKE.CORTEX.DATA_AGENT_RUN) and returns the answer as a ROW OF DATA.
        │
        ▼
3. That answer row lands in the display instance's dataView (the "Answer text"
   role); it renders the new answer in a bubble on its next update().
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
  has slicer semantics: it filters every *other* visual on the page, never the
  applier's own query. The `selfFilter` scope does NOT rescue this — three live
  tests applied it (no synchronous error) and the parameter never moved. Hence the
  two-instance design: an input-only instance sends, a display instance (Answer
  text bound) receives. 1.0.6.0 stopped applying `selfFilter` and actively clears
  stale ones left by earlier builds.
- **Agent runs take minutes, not seconds** — 200s observed for a single question.
  The visual's give-up point is the Format-pane **Answer timeout** setting
  (default 600s); a too-short timeout looks exactly like a broken pipeline.
- **`applyJsonFilter` failures are silent — and it returns `void`, not a promise.**
  Builds ≤ 1.0.7.0 chained `.then/.catch` on it; that was dead code (optional
  chaining made it a silent no-op), so their "ⓘ … acknowledged by host" lines never
  printed and never could. The only real observables: a synchronous validation
  throw (surfaced as `⚠ … failed`) and the `options.jsonFilters` echo on
  subsequent updates (the `ⓘ` lines).
- **Filter shape didn't explain the self-query failure, but it can still disqualify
  parameter resolution.** A visual-applied filter (Basic `In` or Advanced `Is` — the
  host persists both normalized to Basic `In` with `requireSingleSelection:false`)
  never fired the applying visual's own query, while a filter-pane Advanced `is`
  card on the same visual works fully — pane cards apply to the visual's own query,
  visual-applied filters don't (previous bullet). Separately, the Dynamic-M docs
  require **single-select semantics** ("use a single select mode in the slicer, or
  require single select in the filter card") when the binding is Multi-select = No —
  so a persisted `requireSingleSelection:false` plausibly disqualifies the filter.
  Since 1.0.7.0 the build emits the slicer-canonical shape directly: Basic `In`,
  one value, `requireSingleSelection: true`.
- **The prompt travels inside a `$$...$$` literal**, so a literal `$$` anywhere in
  the question (or in a context cell value) would terminate the literal and break
  the SQL. Since 1.0.8.0 the visual neutralizes `$$` → `$ $` before applying the
  filter — a transport constraint, not sanitization.
- **Stale filters are silent test-killers.** `applyJsonFilter(..., merge)` persists
  into the .pbix and nothing ever removed it, so an old question can linger on a
  visual (at either scope) and conflict with the new value — the parameter then can't
  resolve to a single value and nothing fires. Same for leftover pane cards like
  leftover pane cards targeting the binding column, and for repeating the same
  question text (the DirectQuery cache serves it — no new Snowflake query, which
  reads as a false negative). Test protocol: fresh visuals, unique question text
  every run. (A pane card reading `is (All)` seen during the 1.0.5.0 round was an
  unrelated field, not `PromptBinding[Prompt]` — it played no part in that failure.)
- Verify the round-trip **in the Power BI Service**, not just Desktop — the
  dynamic-data-source refresh restriction only bites in the Service.

## Where debugging stands

Last updated 2026-07-09, visual build **1.0.8.0** (1.0.6.0 fixed the defect that
invalidated the 1.0.5.0 two-instance test, dropped `selfFilter`, and added a
force-input-mode backstop + a filter-clear action; 1.0.7.0 switched the emitted
filter to the slicer-canonical Basic `In` + `requireSingleSelection:true` shape;
1.0.8.0 removed the dead promise-chain "ack" diagnostics — `applyJsonFilter`
returns `void` — and neutralizes `$$` in the prompt). Built, not yet live-tested.
A second independent (LLM) review of the 1.0.3.0-era code corroborated the
slicer-semantics theory and contributed the dead-ack finding, the `$$` hazard,
the Query-reduction check, and the Filter By List tie-breaker below.

**Symptom matrix (all verified live):**

| Test | Result |
|---|---|
| Edit `PromptParameter` Current Value manually in Power Query, refresh | **Works.** Agent runs (~200s), real `ANSWER_TEXT` returns |
| Filter pane: drag `PromptBinding[Prompt]` onto a plain table's "Filters on this visual", Advanced filtering, `is`, typed value | **Works.** `DATA_AGENT_RUN` appears in Snowflake Query History. Column is in no field well of that table |
| Click Send in the custom visual (Basic `In` ≤ 1.0.2.0, Advanced `Is` 1.0.3.0+) | **Fails.** No query ever appears in Query History — the parameter never moves. Filter shape makes no difference; fails even with a 5-character question and context off |
| 1.0.4.0 diagnostics: `options.jsonFilters` echo after Send | **Filter IS persisted.** Host echoes it back attached to the visual — normalized to Basic `In` + `requireSingleSelection:false` even when we emitted Advanced `Is`. So the host parses, canonicalizes, and stores the filter… and the applying visual's query never re-runs |
| Send in the visual (arms the spinner), then hand-apply the same filter via the pane **on the chat visual itself** | **Full success.** Agent ran and the answer **rendered in the chat bubble** — parameter, M, Snowflake, dataView readback, and render-while-busy all proven |
| 1.0.5.0 "Test A": `PromptBinding[Prompt]` in the new well **on the same visual** (Answer text still bound), Send | **Fails identically.** Filter persisted (echo again Basic `In`), no query, 600s timeout. Having the field in a well doesn't make the visual's own query honor its own filter |
| 1.0.5.0 "Test B": second instance with only Prompt bound | **Invalid — never ran.** The instance stayed in display mode ("no context fields bound" chip, not "input mode"), and removing Answer text popped Desktop's "an error occurred while rendering the report". Root cause found in OUR capabilities.json — see below |

**Root cause of the Test B failure (fixed in 1.0.6.0):** the two
`dataViewMappings` condition sets **overlapped** — with only the prompt field
bound, the categorical mapping matched *and* the table mapping's condition
(`promptField ≤ 1`) matched too. The host's behavior under ambiguous conditions
produced the rendering error and a table-shaped dataView with no prompt column,
so input-mode detection failed. 1.0.6.0 makes the three condition sets mutually
exclusive (input / combo / display) and pins that with a unit test
(`tests/unit-capabilities.mjs`). Detection is also hardened: it scans **all**
dataViews for the role, falls back on the mapping *shape* (only the prompt role
maps to categorical, so a categorical dataView with empty metadata — the
zero-row-table edge — still detects), and there's a manual **Format → Cortex
Agent → Force input mode** toggle as the last-resort backstop.

**Working theory (upgraded, consistent with every observation — and now
externally corroborated):** `applyJsonFilter` at the `general/filter` scope has
**slicer semantics — the filter applies to every other visual on the page and
never to the applier's own query.** Pane filter cards DO apply to the visual's
own query, which is why the hand-applied card worked end to end. `selfFilter`
doesn't rescue the single-visual design (applied without error three times,
parameter never moved — it appears to be a search-style reduction, not a
query-context filter; note the pane-card success proves a true query-context
filter on this column works *without* projection, so if `selfFilter` behaved
like one, it would have fired). A 2026-07-09 docs/community research pass confirmed the
semantics and surfaced one extra qualifier:

- The archived official API reference describes `applyJsonFilter` as passing a
  filter to the host "for filtering **other** visuals"
  (microsoft.github.io/PowerBI-visuals/api/references/applyjsonfilter), and
  community resolutions state it plainly: "the 'filter' argument … filters all
  visuals **except the current one**; to filter the current visual, 'selfFilter'
  must be used instead" (stackoverflow.com/questions/76279165). `selfFilter`
  exists only in the capabilities schema — no Learn docs; whether it can drive a
  Dynamic-M parameter was publicly untested before our three live failures.
- The Dynamic-M docs (learn.microsoft.com/power-bi/connect-data/desktop-dynamic-m-query-parameters)
  never mention the visual filter API in either direction, but Chris Webb's post
  on this exact architecture recommends the **Filter By List custom visual** for
  feeding arbitrary values to a bound parameter — implying API-applied filters
  *can* drive parameters in *other* visuals' queries (blog.crossjoin.co.uk,
  2023-01-29). No public end-to-end proof either way — and Filter By List itself
  is unusable for us (org-blocked; recent AppSource reviews report it broken),
  so it stands as evidence, not a tool.
- The same docs require **single-select semantics** when the binding is
  Multi-select = No ("use a single select mode in the slicer, or require single
  select in the filter card"). The host persisted our filters with
  `requireSingleSelection:false` — a plausible disqualifier even in a correct
  two-instance setup, closed off in 1.0.7.0 by emitting Basic `In` + one value +
  `requireSingleSelection:true` (exactly what a single-select slicer produces).

Consequences:

- A **single-visual** chat can never fire its own DirectQuery. Test A could not
  have succeeded regardless of wells.
- The **two-instance** design is the load-bearing test, and it has still never
  validly run: the improvised 1.0.5.0 attempt ran with the copy stuck in display
  mode, a rendering error on the page, and (likely) **stale conflicting filters**
  — builds ≤ 1.0.5.0 merged filters at both scopes and never removed them, so old
  questions persisted on both instances; two different values on the same column
  make the parameter unresolvable. 1.0.6.0 applies the outbound scope only,
  clears the `selfFilter` scope on every send, and Send-with-an-empty-box now
  removes this visual's prompt filters entirely (a reset that doesn't require
  deleting the visual).

**Eliminated (don't re-tread):** the 180s timeout (real, fixed via the
Answer-timeout setting, but no query is ever issued); the "Require user approval
for new native database queries" option (off); Model-view Bind-to-parameter
(verified); name mismatches; prompt payload size; filter shape (Basic vs
Advanced identical, host normalizes to Basic `In` anyway); the
`dataPoint`-vs-`general` packaged-visual pitfall (we use `general`); H1 "host
silently drops the filter" (refuted by the jsonFilters echo); "the visual must
own the target field in a well" as a *single-visual* fix (refuted by Test A);
the answer-readback path (proven working by the pane test).

### Fast iteration: the echo probe (no agent cost, answers in seconds)

Waiting 3+ minutes and checking Query History per attempt made every round
glacial. For filter debugging, temporarily replace `CortexAnswerQuery`'s
**entire Advanced Editor contents** with a probe that just echoes the parameter
back:

```m
let
  Source = Snowflake.Databases(
             "msu-prod.east-us-2.privatelink.snowflakecomputing.com",
             "POWERBI_WHS_2",
             [Implementation = "2.0", Role = "SG_MSU_CORTEX_CHAT_PILOT"]),
  Db    = Source{[Name = "DBS_ANALYTICS_AI"]}[Data],

  Sql   =
    if Text.Trim(PromptParameter) = "" or PromptParameter = "__no_prompt__" then
      "SELECT CAST(NULL AS STRING) AS ANSWER_TEXT, CAST(NULL AS STRING) AS GENERATED_SQL, 'IDLE' AS STATUS"
    else
      "SELECT 'ECHO: " & Text.Replace(PromptParameter, "'", "''") & "' AS ANSWER_TEXT, CAST(NULL AS STRING) AS GENERATED_SQL, 'ECHO' AS STATUS",

  Result = Value.NativeQuery(Db, Sql, null, [EnableFolding = true])
in
  Result
```

To restore, paste back the full real definition from step 2 → Step 3 above
(same query, agent call instead of the echo `SELECT`). If the filter →
parameter link works, the display instance's bubble fills with `ECHO: <your
question>` within seconds, and Query History shows the trivial `SELECT`. Every
send is near-free, so you can iterate on the visual side rapidly and only run
the real agent once the echo works.

### The 1.0.8.0 test (two instances, clean slate)

1. **Clean slate.** Delete ALL old chat-visual instances from the page (this
   purges their stale persisted filters), remove any filter-pane cards
   targeting `PromptBinding[Prompt]` at any scope if one exists, then import
   `dist/...1.0.8.0.pbiviz`. Also check **File → Options → Query reduction**:
   everything OFF (no "Apply" buttons on slicers/filter pane) — enabled, it
   defers filter changes and could hold API-applied filters too.
2. **Swap in the echo probe** above.
3. **Display instance:** bind `CortexAnswerQuery[ANSWER_TEXT]` to **Answer
   text** and — for this round — leave **Context fields empty** (fact-table
   columns and the `CortexAnswerQuery` island share one table query; keep that
   variable out until the mechanism is proven). **Input instance:** a second
   copy with ONLY `PromptBinding[Prompt]` in **Prompt binding field** — its
   chip must read **"input mode"** (if not, flip Format → Cortex Agent →
   Force input mode).
4. Type a **unique** question in the input instance, Send. Expect within
   seconds: `ECHO: <question>` in the display instance. The input instance's
   transcript echoes what the host actually persisted (`ⓘ` lines) for two
   minutes after each send — an empty `[]` there means the filter wasn't even
   stored.
5. If the echo works: restore the real query definition (Build it → step 2 →
   Step 3), ask a real question, allow
   minutes — that's the full pipeline.
6. If the echo does NOT arrive, discriminate in this order:
   - **Query History**: probe `SELECT` present → the parameter moved and only
     readback failed; absent → the parameter never moved.
   - **Performance Analyzer** (View ribbon): refresh the display instance and
     inspect its query — a `DEFINE MPARAMETER` carrying the typed question
     means the filter reached the query and the problem is downstream.
   - **Binding-health control (~3 min): a native slicer.** (The Filter By List
     visual would have been the API-path control, but it's unusable here —
     org-blocked, and recent AppSource reviews report it broken. Microsoft's
     Text Filter is no substitute: it emits `Contains`, which is on the
     Dynamic-M unsupported-operations list.) First click Send with an **empty
     box** on the input instance to clear its filter (a leftover value would
     conflict with the slicer's and stall the parameter). Then in Power Query
     give `PromptBinding` one temporary row —
     `#table(type table [Prompt = text], {{"CONTROL QUESTION 123"}})` —
     Close & Apply, add a **native Slicer** on `PromptBinding[Prompt]`, and
     click the value. `ECHO: CONTROL QUESTION 123` appearing in the display
     instance proves the binding → parameter → DirectQuery chain is healthy,
     which isolates the failure to API-applied filters — the free-text design
     is then dead, and the **suggested-questions fallback** (pre-populate
     `PromptBinding` with curated questions; a native single-select slicer
     drives the parameter; display instance unchanged) is *already proven by
     this very control*. No echo from the slicer either = the parameter
     binding itself is broken in this .pbix — recreate the binding in a fresh
     file (a known, never-explained community failure bucket) before
     concluding anything. Afterwards revert `PromptBinding` to zero rows
     (`{}`) and delete the slicer.

**Also since 1.0.5.0:** the prompt ends with a plain-text formatting
instruction, because the agent returned a markdown table and the visual
deliberately renders plain text only (`textContent`, the XSS posture). Proper
rich rendering stays a Phase 2 concern.

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

Import the `.pbiviz`, then add **two instances** to the page — a visual-applied
filter never applies to the applier's own query (slicer semantics), so the
sender and the receiver must be separate:

- **Display instance** — bind `CortexAnswerQuery[ANSWER_TEXT]` to **Answer
  text**; optionally bind your filter dimensions/measures (Region, Year, …) to
  **Context fields**. Leave **Prompt binding field** empty.
- **Input instance** — a second copy with ONLY `PromptBinding[Prompt]` in
  **Prompt binding field** (nothing else bound anywhere). Its chip reads
  **"input mode"**; if detection ever fails (zero-row-table edge), flip
  **Format → Cortex Agent → Force input mode** on.
- On the display instance, in **Format → Cortex Agent**, size **Answer timeout
  (seconds)** above your slowest observed agent run (default 600). The
  **Prompt binding table/column** names only matter for a display instance
  sending without a bound prompt column (the input instance derives the target
  from the bound field itself).

Type the question in the **input** instance. The **display** instance's bubble
fills in when the answer row arrives (it renders any new answer, whether or not
it asked). Sending with an **empty box clears** that visual's persisted prompt
filters — do that (or delete the visuals) when a test leaves an old question
merged in. A synchronous filter-validation error appears as a muted
`⚠ ... failed` line in the transcript (`applyJsonFilter` returns `void`, so
that's the only direct error channel); for two minutes after each send the
transcript also echoes what the host actually persisted (`ⓘ` lines).

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
- **Query reduction options** (File → Options → Query reduction): keep everything
  off. "Apply" buttons defer slicer/filter changes and can hold the visual's
  applied filter the same way.
- **Context fields + Answer text share one table query.** `CortexAnswerQuery` is
  its own disconnected island; binding fact-table columns alongside `ANSWER_TEXT`
  can hit "can't determine relationships between the fields". If that bites once
  context is re-enabled, the queued fix is a measure-friendly answer role (e.g.
  `MAX(ANSWER_TEXT)`) — measures aggregate across unrelated islands.
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
