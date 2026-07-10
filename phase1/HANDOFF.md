# Phase 1 handoff — the complete playbook for whoever picks this up

**Audience:** a future AI assistant (any capability level) or a human developer
taking over Phase 1 after "Round 10" (defined below). This document assumes NO
memory of the debugging saga. Read this file top to bottom before doing
anything. The full forensic history lives in [README.md](README.md) →
"Where debugging stands"; this file tells you **what to do next**, for every
way Round 10 can turn out, and several steps beyond that.

**Non-technical summary:** we built a chat box inside a Power BI report that
asks a Snowflake AI agent questions about the data. The *answering* machinery
works end to end. The one broken piece is *how the user's typed question gets
into the pipeline*. Ten test rounds narrowed it to a Power BI platform rule,
and Round 10 tests the last workaround. Depending on that result, the product
ships with one of three input methods — all described below with exact steps.

---

## 1. Mental model (learn this before touching anything)

```
[user provides a question]
        │  as a FILTER on the column PromptBinding[Prompt]
        ▼
[Dynamic M parameter]  PromptParameter — bound to that column in Model view
        ▼
[CortexAnswerQuery]    DirectQuery; its native SQL calls the Snowflake agent
                       (SNOWFLAKE.CORTEX.DATA_AGENT_RUN) with the parameter
        ▼
[answer row]           ANSWER_TEXT / GENERATED_SQL / STATUS
        ▼
[chat visual, display instance] renders any new non-empty ANSWER_TEXT
```

Four model objects (all defined in README "Build it"):
- `PromptParameter` — Text M parameter. Default `__no_prompt__` is a sentinel:
  the M short-circuits it to a free IDLE row so opening the file never runs
  (or bills) the agent.
- `PromptBinding` — tiny disconnected table, one text column `Prompt`. In
  Model view, `Prompt` is **bound to the parameter**. This binding is the
  single most fragile thing in the system (see landmines).
- `CortexAnswerQuery` — the DirectQuery. During testing it is swapped for an
  "echo stub" that returns `ECHO [<timestamp>]: <question>` instantly and
  free, instead of the 2–4 minute billable agent call.
- The **custom visual** (v1.0.12.0, `visual/`) — two instances on the page:
  INPUT (only `Prompt` bound; chip says "input mode") and DISPLAY
  (`CortexAnswerQuery[ANSWER_TEXT]` bound to Answer text). There is also a
  native table "Test Cortex Table" (the CANARY) showing all three answer
  columns — the primary test observable, because it can't be misconfigured.

## 2. What is PROVEN, DISPROVEN, and OPEN (as of 2026-07-10, Round 9 done)

PROVEN (do not re-test):
- Manual parameter edit → agent runs → answer returns. (Round 0)
- **Filter-pane card** (Advanced "is", arbitrary typed value, zero-row column)
  → parameter resolves in seconds. Timestamped proof 15:15:10 Round 8. Also
  proven end-to-end with a real agent answer rendering in the chat bubble.
- **Native list-slicer selection** of an existing row → parameter resolves →
  agent ran end to end (Round 3 control; the answer appeared in a native
  debug table — the same table later formalized as the CANARY).
- The display visual renders any new non-empty answer, including answers it
  didn't ask for (fixed in 1.0.9.0 after a live-caught bug).
- Filter propagation: a visual-applied filter reaches other visuals' queries
  (display logs a data update at the exact send second).

DISPROVEN (do not re-try; evidence in README matrix):
- Single-visual design: a visual's filter NEVER applies to its own query
  (documented slicer semantics) and `selfFilter` doesn't rescue it.
- Visual-API filters under a **Multi-select=No** binding, in every shape:
  Basic In (member and non-member values), Advanced Is, ChicletSlicer-style
  Identity. Root cause (Round 9 transcript): the host rewrites every
  visual-submitted filter to Basic In + `requireSingleSelection:false`, which
  fails the docs' single-select requirement for Multi-select=No bindings.

OPEN (Round 10 tests exactly these):
- **Multi-select=Yes binding + visual Basic In** — the last principled lever;
  the only known working zero-row custom-visual demo (Chris Webb's Filter By
  List) used Multi-select=Yes. Requires list-tolerant M (blocks below).
- Native **Input slicer** with operator "Is any" typed free text (Round 9's
  attempt had a configuration caveat: operator may have been set after the
  text was applied).
- Re-proof of the list slicer against the echo probe (formality).

## 3. The state you inherit

- Visual build **1.0.12.0** imported in the working .pbix (chips, Filter
  shape selector, Plain-text hint toggle, timestamped transcript diagnostics).
  Source `visual/`, packaged artifact `visual/dist/*.1.0.12.0.pbiviz`
  (dist/ is gitignored — rebuild with the gates commands in §11 item 4 if
  missing).
- `PromptBinding` = three curated questions (Round 9 Block 1c).
- `CortexAnswerQuery` = an echo stub (Round 9's, scalar-only) unless Round 10
  step 2 already replaced it with the list-tolerant stub (§5 Block E1).
- Round 10's analyst script was delivered 2026-07-10 (its content is
  reproduced by §5 + §6 — the blocks and the decision tree).
- Ryan CANNOT run anything touching Snowflake (privatelink + broken ZScaler)
  and CANNOT Close & Apply Power Query changes. An analyst executes all
  Power Query work and all live tests. Scripts for the analyst must be
  fluff-free, fully self-contained (every M block inline at the step where
  it's used — never "see previous message"), with exact click paths,
  screenshots at every step, and in-session fallbacks (never stop at the
  first failure; each Ryan↔analyst exchange costs days).

## 4. Non-negotiable testing discipline (all learned the hard way)

1. **Echo stub first.** Never debug against the real agent — 2–4 min and
   billable per attempt vs seconds and free.
2. **The CANARY is the primary observable.** Chat visuals can be
   misconfigured; the plain table can't lie.
3. **Never reuse question text** from any prior round — Power BI's
   DirectQuery cache serves repeats with no new query (false negative).
4. **One action at a time; hands off while waiting.** Changing filters
   mid-flight cancels the running query.
5. **Re-check "Bind to parameter" after ANY edit to `PromptBinding`** (Model
   view → Prompt column → Properties → Advanced). Recreating that table can
   silently blank the binding.
6. **Power Query edits do nothing until Close & Apply** — and every Close &
   Apply recreates the visuals (transcripts wipe; the "new instance" line
   reappears — that's normal and diagnostic).
7. **Empty-box Send on the input visual clears its persisted filter.** Do it
   before saving any file (a saved live question re-runs the billable agent
   on every open) and before any control experiment on the same column.
8. **Trust only screenshots.** The visual's transcript lines are wall-clock
   timestamped for exactly this reason. "It didn't work" without screenshots
   has been wrong twice in this project.
9. Suggestion chips render **alphabetically** (the host sorts the category).
   Reference chips by their text, never by position.
10. A mid-flight DirectQuery visual still displays its PREVIOUS result — a
   canary showing IDLE seconds after a send means "still running", not "failed".

## 5. Canonical M block library (copy-paste; keep these exact)

**Block Z — `PromptBinding`, zero rows (free-text designs):**
```m
let Source = #table(type table [Prompt = text], {}) in Source
```

**Block Q — `PromptBinding`, curated questions (slicer/chip designs; edit the
question list freely, keep the shape). These three questions ARE the rows in
the working .pbix as of Round 9 — if in doubt, read the actual texts off the
chips/slicer on screen:**
```m
let Source = #table(type table [Prompt = text], {
  {"Which category had the highest dollar sales in the latest 13 weeks?"},
  {"Which platform declined the most versus a year ago?"},
  {"What were total sales for the Taste Elevation platform in the latest 13 weeks?"}
}) in Source
```

**Block E1 — `CortexAnswerQuery`, echo stub, list-tolerant (works under BOTH
Multi-select modes — the standard probe from Round 10 on):**
```m
let
  Source = Snowflake.Databases(
             "msu-prod.east-us-2.privatelink.snowflakecomputing.com",
             "POWERBI_WHS_2",
             [Implementation = "2.0", Role = "SG_MSU_CORTEX_CHAT_PILOT"]),
  Db    = Source{[Name = "DBS_ANALYTICS_AI"]}[Data],

  P     = if PromptParameter = null then "__no_prompt__"
          else if Value.Is(PromptParameter, type list) then
            (if List.IsEmpty(PromptParameter) then "__no_prompt__"
             else Text.Combine(List.Transform(PromptParameter, Text.From), " "))
          else Text.From(PromptParameter),

  Sql   =
    if Text.Trim(P) = "" or P = "__no_prompt__" then
      "SELECT CAST(NULL AS STRING) AS ANSWER_TEXT, CAST(NULL AS STRING) AS GENERATED_SQL, 'IDLE' AS STATUS"
    else
      "SELECT 'ECHO [' || CURRENT_TIMESTAMP()::string || ']: " & Text.Replace(P, "'", "''") & "' AS ANSWER_TEXT, CAST(NULL AS STRING) AS GENERATED_SQL, 'ECHO' AS STATUS",

  Result = Value.NativeQuery(Db, Sql, null, [EnableFolding = true])
in
  Result
```

**Block R1 — `CortexAnswerQuery`, REAL agent, list-tolerant (the production
query from Round 10 on; works under both Multi-select modes):**
```m
let
  Source = Snowflake.Databases(
             "msu-prod.east-us-2.privatelink.snowflakecomputing.com",
             "POWERBI_WHS_2",
             [Implementation = "2.0", Role = "SG_MSU_CORTEX_CHAT_PILOT"]),
  Db    = Source{[Name = "DBS_ANALYTICS_AI"]}[Data],

  P     = if PromptParameter = null then "__no_prompt__"
          else if Value.Is(PromptParameter, type list) then
            (if List.IsEmpty(PromptParameter) then "__no_prompt__"
             else Text.Combine(List.Transform(PromptParameter, Text.From), " "))
          else Text.From(PromptParameter),

  Body  = Text.FromBinary(Json.FromValue(
            [ messages = { [ role = "user",
                             content = { [ type = "text", text = P ] } ] } ])),

  Sql   =
    if Text.Trim(P) = "" or P = "__no_prompt__" then
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

## 6. Round 10 — what it tested and how to read the results

Round 10 (script delivered 2026-07-10; numbered exactly as sent): **step 1**
reset (empty-box Send; verify v1.0.12.0 + chips) → **step 2** Block E1 pasted
into `CortexAnswerQuery` + Close & Apply → **step 3** binding check →
**step 4 = Test A** native list slicer (single-select) clicks a curated
question → **step 5 = Test B** Input slicer with operator "Is any" set BEFORE
typing → **step 6 = Test C** binding flipped to **Multi-select = Yes**, then
the chat visual sends free text (Filter shape = Basic 'In', Plain-text hint =
Off; chip fallback) → **step 7** real run via Block R1 through the earliest
passing path (Multi-select reverted to No unless Test C won) → **step 8**
cleanup. Pass = `ECHO [timestamp]: <text>` in the canary within 2 minutes.

Read the results, then follow exactly ONE of the outcome playbooks below.

---

## 7. OUTCOME C — Test C passed ("back from the dead": free text through our visual)

**Meaning:** Multi-select=Yes removes the single-select disqualifier; the
chat visual's own send works. Phase 1 becomes the originally-designed product.

**Playbook:**
1. **Lock the model config:** Multi-select stays **Yes**; Block R1 is the
   permanent `CortexAnswerQuery`; `PromptBinding` can keep curated rows
   (chips become real UX) or go zero-row (pure free text) — recommend keeping
   the rows: chips + free text both work.
2. **Confirm robustness (one analyst session):** with Block E1, echo test
   (a) free text WITH "Plain-text answer hint" back ON (the suffix changes
   the value — confirm arbitrary multi-line values still resolve), (b) two
   questions back-to-back (dedupe/liveness), (c) a chip click, (d) empty-box
   clear then re-ask the SAME question (dedupe-reset path). Then Block R1 +
   one real question.
3. **Polish build 1.0.13.0** (spec in §11): remove the input/display split?
   NO — self-exclusion still holds (a visual never filters its own query),
   so the two-instance design remains; polish per §11.
4. Update README: status banner → "WORKING — free text via Multi-select=Yes";
   move the Multi-select instructions into "Build it" Step 4; record Round 10
   in the matrix. Update repo-root CLAUDE.md's phase1 bullet the same way.
5. **Watch-outs for this outcome:** (a) with Multi-select=Yes a user could
   multi-select in slicers → P concatenates values with a space — harmless
   for the echo, weird for the agent; document it. (b) If future rounds show
   the parameter as a LIST breaking anything, every M block here already
   guards it. (c) RLS remains incompatible with Dynamic M — unchanged.

**If C passed but the real run (step 7) failed:** the input path is fine —
debug the answer path. Check, in order: the canary (agent/SQL errors appear
there as error rows or the visual shows an error icon), Snowflake agent
observability (did DATA_AGENT_RUN fire? how long?), the display transcript's
`ⓘ data:` lines (did a row arrive and what did the visual decide?). The known
render edge-cases are documented in visual.ts around the render block
(dedupe: two different questions with byte-identical answers dedupe
silently; a transiently-empty dataview can re-render the same answer once).

## 8. OUTCOME B — only Test B passed (free text via native Input slicer)

**Meaning:** free text survives through a native visual; our chat visual
becomes display-only.

**Playbook:**
1. Revert Multi-select to **No** (it didn't help and adds list semantics for
   no benefit). `CortexAnswerQuery` = Block R1 anyway (list-tolerant is safe).
2. Page design: Input slicer (operator locked to **"Is any"**) styled and
   placed under/next to the DISPLAY chat visual; DELETE the input chat
   instance (its send path is dead; deleting removes its persisted filters).
3. Verify (one session): echo → Input slicer typed question → canary + chat
   bubble; check the "Is any" operator SURVIVES saving/reopening the file and
   publish-to-Service (unverified as of writing — if it resets to "Contains
   any" after reopen, that's a blocker for this design; escalate to Outcome A
   design with Input slicer as bonus-only).
4. Polish build 1.0.13.0 per §11 (display-only variant).
5. README/CLAUDE.md updates as in Outcome C step 4 (banner: "WORKING — free
   text via native Input slicer").

## 9. OUTCOME A — only Test A passed (curated-questions slicer)

**Meaning:** input = picking a curated question from a native list slicer.
No arbitrary free text in the report (except the pane-card trick below).

**Playbook:**
1. Revert Multi-select to **No**. `CortexAnswerQuery` = Block R1.
2. Work with stakeholders to curate 5–15 REAL demo questions → update Block Q
   → analyst applies → binding re-check → echo test each question once (cache
   rule: each question's FIRST click echoes; repeats come from cache).
3. Page design: list slicer (single-select) + DISPLAY chat visual; delete the
   input chat instance.
4. **Ad-hoc free text for power users:** document on the report page (a text
   box) that any user can drag `PromptBinding[Prompt]` into "Filters on this
   visual" on the chat visual → Advanced filtering → "is" → type any
   question → Apply filter. This is fully proven (Round 8, and end-to-end
   with a real answer in an earlier round).
5. Polish + docs as above (banner: "WORKING — curated-question slicer").

## 10. OUTCOME ∅ — nothing passed (including A, which SHOULD pass)

Test A failing contradicts Round 3's live proof — suspect execution or file
state before suspecting the platform:
1. Verify from the screenshots: binding non-blank AFTER the last Close &
   Apply? Echo stub actually applied (transcript/canary show `ECHO [` on the
   pane-card control below)? Slicer actually single-select with a question
   VISIBLY selected?
2. Run the always-true control: pane card on the CANARY table — Filters pane
   → drag `PromptBinding[Prompt]` → Advanced filtering → "is" → unique text →
   Apply filter. This has NEVER failed. If it fails too → the .pbix is
   corrupted → rebuild the model from scratch per README "Build it" §2 in a
   FRESH file (known community precedent of unexplained binding rot; a fresh
   file fixed it for others).
3. If the pane card works but slicers don't in a fresh file → Desktop
   version/tenant investigation: record exact Desktop version (Help → About),
   try another machine, and post the discrimination to the Fabric community
   (the README matrix is the write-up; it's a strong bug report).
4. Ship the stopgap meanwhile: pane-card free text + chat display is a
   working, proven demo (Outcome A step 4's mechanism, minus the slicer).

## 11. The polish build (1.0.13.0) — spec for whichever outcome wins

Work in `phase1/visual/`. Bump BOTH `pbiviz.json` "version" AND
`VISUAL_VERSION` in `src/visual.ts` (they must match; a unit test does not
enforce this — check manually). Changes:
1. **Diagnostics toggle:** new format-pane switch `showDiagnostics` (objects
   `agent.showDiagnostics` bool + settings.ts ToggleSwitch, default **Off**
   for demo). Gate every `addActivity` line that starts with `ⓘ` behind it
   (the `⚠` warnings stay always-on). Keep the "new instance" line gated too.
2. **Display-only chrome:** when NOT in input mode and `answerText` is bound,
   hide the input row + Send button (`cc-inputrow`) — the send path is dead
   for display instances under every outcome except C. Under Outcome C, skip
   this change for the INPUT instance only (input row stays on input mode).
   Simplest rule that covers all outcomes: input row visible ONLY in input
   mode; under outcomes A/B there is no input instance so no input row
   anywhere.
3. **Re-enable report context** (the feature that makes this product
   interesting): change the `answerText` dataRole kind from `Grouping` to
   `GroupingOrMeasure` in capabilities.json. The analyst creates a measure
   `Answer = MAX(CortexAnswerQuery[ANSWER_TEXT])` and binds THAT to Answer
   text; measures aggregate across unrelated tables, so Context fields from
   fact tables can coexist without the "can't determine relationships" error
   (the unrelated-islands landmine — `CortexAnswerQuery` is its own island).
   Test with the echo stub: bind 2–3 context fields + the measure; ask; the
   echo must still render and `buildContextBlock` (already answer-column-
   aware) must exclude the answer from context. THEN test the real agent
   once with "Send report context" ON — the prompt now carries filtered rows.
4. Gates before any PR (run from repo root):
   `bash phase1/visual/tests/run-tests.sh` (20 tests must pass) and
   `(cd phase1/visual && ./node_modules/.bin/pbiviz package)` (needs
   `npm install --no-audit --no-fund` in phase1/visual once). CI runs the
   same on PR.
5. Ship: branch `feat/...` or `fix/...` → stage SPECIFIC files (never
   `git add -A`) → commit (Co-Authored-By trailer per repo convention) →
   push → `gh pr create --fill` →
   `gh pr merge --squash --auto --delete-branch || gh pr merge --squash --delete-branch`
   (the `--auto` form waits for CI; the fallback covers repos where auto-merge
   is disabled).

## 12. Demo readiness checklist (after polish)

- [ ] Real agent query (Block R1) applied; echo stub gone; parameter at
      `__no_prompt__`; input filters cleared; file saved in that state.
- [ ] One full real-question run witnessed in Desktop (bubble + canary).
- [ ] The same verified in the **Power BI Service** (the dynamic-data-source
      restriction only bites there — see README Gotchas; the prompt is in the
      query body, which is fine, but VERIFY once).
- [ ] Canary table removed or moved to a hidden debug page.
- [ ] Diagnostics toggle Off; "Send report context" per demo plan; Answer
      timeout ≥ 600s.
- [ ] README "Build it" reflects the final model config (Multi-select mode,
      block choices) so the demo can be rebuilt from scratch.
- [ ] Cost note acknowledged: every distinct question = one billable agent
      run, ~2–4 minutes.

## 13. Landmine index (details in README "Field notes" + "Gotchas")

binding severed by PromptBinding edits · pending-unapplied Power Query edits
(files staged offline run OLD queries) · DirectQuery cache vs repeated
questions · mid-flight filter changes cancel runs · stale persisted filters
in saved files (billable run per open + unprompted answer) · `$$` in prompts
(visual neutralizes since 1.0.8.0) · host rewrites visual filters (Basic In,
RSS:false) · unrelated-islands join error (context + answer in one table
query) · "Send report context" resets to On per fresh instance ·
`applyJsonFilter` returns void (no error channel) · Desktop recreates visuals
on every Close & Apply · chips sort alphabetically · zero-row column shows
0 rows in the visual's own dataview when the only bound column is NULL.

## 14. If you are an AI model working on this repo

- Repo root = Phase 2 (separate product, don't touch for Phase 1 work; its
  gates: `bash tests/run-tests.sh`, `bash tools/run-e2e.sh`, and
  `(cd visual && ./node_modules/.bin/pbiviz package)`). Phase 1 lives
  entirely in `phase1/`.
- Read `CLAUDE.md` (repo root) for current status one-liners; keep both it
  and README "Where debugging stands" updated with every result — they are
  the project's memory. Record every live-round result in the README matrix
  with timestamps from the screenshots.
- Analyst scripts: follow §3's last paragraph and §4 to the letter. When in
  doubt, over-explain the click path and inline the code.
