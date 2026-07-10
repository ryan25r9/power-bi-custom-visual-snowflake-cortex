# Phase 1 — Cortex chat with no proxy (M-query round-trip)

A quick-to-demo version of the chat visual that needs **no Azure Function, no CORS,
no web-security wiring — and no Snowflake objects at all**. The trade-off: one
question at a time, no streaming (the answer arrives all at once after a few
minutes), and no conversation memory.

The look is the same as the Phase 2 visual — same bubbles, same context chip — minus
the streaming cursor and the Stop button.

> **Status: mechanism PROVEN, final confirmation pending.** Round 3 (2026-07-09,
> build 1.0.8.0) demonstrated the full chain live: a question typed in the input
> instance moved the Dynamic M parameter and the display instance rendered the
> result — the applyJsonFilter → parameter link that blocked builds 1.0.0–1.0.5
> works under the two-instance design. One last-mile bug remained (the display
> visual swallowed the real agent answer after a Power Query Close & Apply;
> fixed in 1.0.9.0) — see [Where debugging stands](#where-debugging-stands).

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
- **Power Query edits do NOTHING until Close & Apply.** A file saved with pending
  edits (Desktop shows the yellow "Apply changes" banner) still runs the OLD
  queries — and applying requires live connectivity, so a machine that can't
  reach Snowflake can stage `.pbiviz` imports and page layout but never query
  changes. This silently invalidated two test rounds (see the staging
  revelation in the debugging section).
- **Editing the `PromptBinding` query can silently sever the parameter binding.**
  Power Query edits that recreate the column (e.g. toggling zero rows ↔ one row)
  can drop Model view's "Bind to parameter" without any visible error — filters
  then persist but the parameter never moves (canary stuck at `IDLE`). Re-verify
  the binding after ANY edit to `PromptBinding`.
- **Changing the filter context mid-run cancels the DirectQuery.** An empty-box
  clear or a second question while an agent run is in flight kills that run; and
  a mid-flight visual still displays its PREVIOUS completed result, so a canary
  showing `IDLE` seconds after a Send just means "still running". One question at
  a time; verdicts come from Snowflake Query History, not from what's on screen.
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

Last updated 2026-07-10, visual build **1.0.10.0** (adds screenshot-grade
diagnostics: every transcript line is wall-clock timestamped; each instance
prints a `Cortex Chat v<version> — new instance` line at birth, so a repeat of
that line mid-session is visible proof the host recreated the visual and wiped
the transcript; the display instance logs every data arrival — row count,
ANSWER_TEXT snippet, and the render decision (`rendering` / `same as last,
skipped` / `dedupe reset`); and a display instance without an Answer-text
binding shows a persistent ⚠ status).

**ROUND 3 (1.0.8.0, live): THE MECHANISM WORKS.** With the echo probe in place,
a question typed in the input instance rendered as `ECHO: <question>` in the
display instance — `applyJsonFilter` → Dynamic M parameter → DirectQuery →
dataView, end to end. The two-instance design (plus the slicer-canonical
filter shape) is the fix; per-change attribution between the 1.0.6.0–1.0.8.0
changes (exclusive mappings, outbound-only + stale-filter clearing,
`requireSingleSelection:true`) is unknown and doesn't matter — keep them all.
The native-slicer control also passed (agent ran off a slicer selection),
independently proving the binding AND the suggested-questions fallback.

**Round 3's residual bug (fixed in 1.0.9.0):** after swapping the real agent
query back in (Close & Apply), real answers rendered in a native debug table
but NOT in the chat visual. Root cause: Desktop **recreates visuals on every
Close & Apply**, and builds ≤ 1.0.8.0 deliberately swallowed the first data
update after construction (a "baseline" meant to suppress stale answers at
report open) — so the freshly recreated display instance ate exactly the
answer it was waiting for. The echo test passed under the same buggy code only
because the echo query is *instant*: the one-shot baseline was consumed by a
stale row seconds after (re)creation, before the tester typed — whereas the
3-minute agent query guarantees the recreated instance's first data update IS
the awaited answer. 1.0.9.0 renders any *new* non-empty answer (deduped, dedupe
reset when the answer column goes back to NULL/IDLE); quiet report-opens are
the `__no_prompt__` idle sentinel's job.
Consequence of the new behavior: a .pbix saved with a live question in the
parameter will render that answer once on open — correct for a data-bound
visual.

**Build lineage:** 1.0.6.0 fixed the overlapping-mappings defect that
invalidated the 1.0.5.0 test, dropped `selfFilter`, added the force-input-mode
backstop + filter-clear; 1.0.7.0 switched to Basic `In` +
`requireSingleSelection:true`; 1.0.8.0 removed dead promise-chain "ack"
diagnostics (`applyJsonFilter` returns `void`) and neutralized `$$` in the
prompt; 1.0.9.0 removed the first-data-update baseline. A second independent
(LLM) review of the 1.0.3.0-era code corroborated the slicer-semantics theory
and contributed the dead-ack finding, the `$$` hazard, and the
Query-reduction check.

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
| 1.0.8.0 Round 3: input instance + echo probe | **WORKS.** `ECHO: <question>` rendered in the display instance seconds after Send — the visual's filter drives the parameter |
| 1.0.8.0 Round 3: real agent query swapped back (Close & Apply), questions asked | **Agent ran, chat stayed silent.** The answer rendered in a native debug table bound to `CortexAnswerQuery` but never in the chat visual — render-side bug, fixed in 1.0.9.0 (see above) |
| 1.0.8.0 Round 3: native slicer on a one-row `PromptBinding` | **Works.** Slicer selection ran the agent end to end — binding healthy, suggested-questions fallback proven viable |
| 1.0.9.0 Round 4: real agent query, question from the input instance | **No answer in ANY visual — including the canary table, which showed `STATUS = IDLE`.** Filter persisted (`ⓘ` echo shows it), so the last *completed* `CortexAnswerQuery` run saw the sentinel: the parameter didn't move (or no run ever completed). Confounds: the file was re-staged offline between rounds (a `PromptBinding` edit can silently sever the Model-view parameter binding — the prime suspect), question 1 was cleared mid-flight (clearing cancels the run), and question 2's verdict may have come inside its 2–4 min window (a mid-flight DirectQuery still displays the previous result — IDLE). Query History wasn't captured. Round 5 discriminates |
| Round 5 (echo probe, re-staged file): reported no echo and an empty Query History | **Inconclusive — every observable in the round was unverifiable as run.** Snowsight's History UI scopes by role/user/warehouse/time and can hide the connection's queries entirely; a reused question is served from Power BI's cache (no SQL ever issued); whether the probe M was actually installed in the file she opened wasn't evidenced; and the Model-view binding check/rebind result went unrecorded. Round 6 makes every step self-evidencing before any conclusion is drawn |

**2026-07-10 staging revelation — Rounds 4 and 5 reinterpreted.** The offline
prep machine can PASTE Power Query edits but cannot **Apply** them (no
Snowflake connectivity), so the Round 4/5 files went out with **pending,
unapplied query edits** — the *applied* model still ran Round 3's end state
(the real agent query, and possibly the one-row `PromptBinding`). Under that
lens: Round 4's `IDLE` canary was the previous completed result (Q1 cancelled
by the mid-flight clear, Q2 judged inside its 3-minute window), and Round 5's
"no echo in 30s" was guaranteed — the applied query was the 3-minute agent,
not the probe. **Both failures are fully consistent with a working mechanism;
nothing observed since Round 3's echo success contradicts it.** The
severed-binding theory demotes to a routine checkbox. Standing rule: ALL
Power Query edits AND the Close & Apply happen on the analyst's machine; the
offline machine only imports the visual and arranges the page.

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
      "SELECT 'ECHO [' || CURRENT_TIMESTAMP()::string || ']: " & Text.Replace(PromptParameter, "'", "''") & "' AS ANSWER_TEXT, CAST(NULL AS STRING) AS GENERATED_SQL, 'ECHO' AS STATUS",

  Result = Value.NativeQuery(Db, Sql, null, [EnableFolding = true])
in
  Result
```

To restore, paste back the full real definition from step 2 → Step 3 above
(same query, agent call instead of the echo `SELECT`). If the filter →
parameter link works, the display instance's bubble fills with
`ECHO [<snowflake timestamp>]: <your question>` within seconds. The embedded
timestamp makes the probe self-evidencing: a **fresh timestamp proves a live
Snowflake round-trip at that moment** (no Query History lookup needed), while
an unchanged timestamp means no new query ran — i.e. a Power BI cache hit from
a reused question, or the parameter didn't move. Every send is near-free, so
iterate on the visual side rapidly and only run the real agent once the echo
works.

### Round 5 (re-verify after the Round 4 failure)

Round 4 failed with the canary at `STATUS = IDLE` (see the matrix). The visual's
apply path is byte-identical to the build that passed Round 3, so the suspects
are file-state and procedure, in this order:

1. **Severed parameter binding (prime suspect, offline-checkable).** Model view →
   select `PromptBinding[Prompt]` → Properties → Advanced → **Bind to
   parameter** must show `PromptParameter`. Editing the `PromptBinding` query
   (zero rows ↔ one row) can recreate the column and silently drop this
   binding. Re-bind if empty. Verify after ANY Power Query edit to
   `PromptBinding`, every time.
2. **Mid-flight cancel.** An empty-box Send (clear) or a second question while
   an agent run is in flight changes the filter context and CANCELS the
   DirectQuery. Round 4's question 1 was cleared mid-flight. Rule: one
   question, then hands off the visual until the answer lands or 5 minutes
   pass.
3. **Premature verdict.** A mid-flight DirectQuery visual still displays its
   PREVIOUS completed result — the canary showing `IDLE` right after a Send is
   what "still running" looks like. Ground truth is Snowflake **Query
   History**, which Round 4 didn't capture.

Protocol (superseded by Round 6 below): verify/fix the binding (offline) →
echo probe in → one never-used question → echo within ~30s → real query →
hands off 2–4+ min. Round 5 as run reported nothing anywhere, but produced no
verifiable evidence either way — see the matrix.

### Round 7 (current protocol — analyst-run end to end)

Supersedes Round 6 (never run). Per the staging revelation, ALL Power Query
work — pasting definitions AND **Close & Apply** — happens on the analyst's
machine; the offline prep machine only imports the `.pbiviz` and arranges the
page. Same one-question-at-a-time rules as above; each numbered step ends in
a screenshot. The v1.0.10.0 diagnostics make the screenshots self-evidencing:
timestamped transcript lines, a `new instance` line proving build + instance
lifetime (it reappearing means the host recreated the visual — expected after
every Close & Apply), and per-data-arrival lines on the display instance
showing row count, answer snippet, and the render decision.

1. **Build check:** open the file; both chat visuals show
   `ⓘ Cortex Chat v1.0.10.0 — new instance` in their transcripts. Ignore any
   yellow "Apply changes" banner — step 2's own Apply supersedes it.
2. **Install the probe (analyst machine):** Power Query → paste the zero-row
   `PromptBinding` definition and the timestamped echo-probe
   `CortexAnswerQuery` definition (both above) → **Close & Apply**. Edits do
   nothing until applied — this un-applied gap is what invalidated Rounds
   4–5. Transcripts reset after Apply (fresh `new instance` lines): expected.
3. **Binding state:** Model view → `PromptBinding[Prompt]` → Properties →
   Advanced → **Bind to parameter** shows `PromptParameter`. Screenshot.
   Rebind + report if blank. (Re-check after any Apply that touched
   `PromptBinding`.)
4. **Echo with proof:** one never-used question in the input instance → Send →
   within ~30s the display bubble reads `ECHO [<timestamp>]: <question>` and
   its transcript logs `data: 1 row(s) … → rendering`. The embedded Snowflake
   timestamp is the round-trip proof — no Query History needed. Screenshot
   both visuals.
5. **Liveness check:** a second never-used question → the timestamp must
   CHANGE. Unchanged timestamp = no new query ran (reused question served
   from Power BI's cache, or the parameter is stuck).
6. **Full pipeline:** paste the real `CortexAnswerQuery` definition (Build it →
   step 2 → Step 3) → **Close & Apply** → ONE never-used question → hands off
   for 2–4+ minutes → answer in the display bubble + canary table. Agent-side
   observability shows the `DATA_AGENT_RUN` for this phase (note: echo tests
   never call the agent, so they won't appear there — the bubble timestamp is
   their evidence).
7. **Empty-box Send before saving** (see Gotchas).

**Optional forensics (only if step 4 shows no echo):** search history for **the
question text itself** — the
   protocol's never-used questions make it a globally unique marker, immune to
   the noise of every other user running this agent (do NOT filter on
   `DATA_AGENT_RUN`; that matches everyone's traffic and floods the row
   limit). In a Snowsight worksheet, with `<QUESTION_FRAGMENT>` replaced by a
   distinctive 4–6 word chunk of the exact question typed:

   ```sql
   SELECT start_time, user_name, execution_status,
          total_elapsed_time/1000 AS secs, LEFT(query_text, 200) AS query_snippet
   FROM TABLE(DBS_ANALYTICS_AI.INFORMATION_SCHEMA.QUERY_HISTORY(
         END_TIME_RANGE_START => DATEADD('hour', -4, CURRENT_TIMESTAMP()),
         RESULT_LIMIT => 10000))
   WHERE query_text ILIKE '%<QUESTION_FRAGMENT>%'
   ORDER BY start_time DESC;
   ```

   Caveat: table functions only show queries the current user/role may view —
   if the report's connection signs in as a different (e.g. shared service)
   user, fall back to the Query History **page** with its "SQL text" filter
   set to the same fragment. Rows present = queries ran and the earlier
   "empty History" was a visibility artifact; verified-zero rows with the
   probe and binding both evidenced (steps 2–3) = the parameter is not
   moving — new information worth a fresh-pbix rebuild of the binding.

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
- **Clear before you save.** The input instance's outbound prompt filter persists
  in the .pbix. A file saved with a live question re-runs the full (billable,
  ~3-minute) agent query on every open — and since 1.0.9.0 renders that stale
  answer as an unprompted bubble. Send with an **empty box** (clears the filter,
  parameter back to `__no_prompt__`) before saving or sharing the file.
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
