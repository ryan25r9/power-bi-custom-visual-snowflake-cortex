# Phase 1 — Cortex chat with no proxy (M-query round-trip)

A quick-to-demo version of the chat visual that needs **no Azure Function, no CORS,
and no web-security wiring**. The trade-off: one question at a time, no streaming
(the answer arrives all at once after a few seconds), and no conversation memory.

The look is the same as the Phase 2 visual — same bubbles, same context chip — minus
the streaming cursor and the Stop button.

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
   DirectQuery that CALLs a Snowflake stored procedure (DATA_AGENT_RUN), which
   runs the Cortex agent and returns the answer as a ROW OF DATA.
        │
        ▼
3. That answer row lands back in the visual's dataView (the "Answer text" role).
   The same visual reads it on its next update() and shows it in a bubble.
```

So the answer comes back as **data**, not an API response. That is the whole trick,
and it's why there's no proxy to secure.

## The two things to prove first (spikes)

Before building anything, confirm these two unknowns in the real environment. Everything
else is low-risk.

**Spike 1 — does the M-parameter round-trip actually fire?**
A Dynamic M parameter binds to a *column value selected by a filter*, not to a visual
property. The visual pushes the prompt by applying a Basic filter on the bound column
(see `src/visual.ts`, the `applyJsonFilter` call). Stand up the binding table +
parameter + a trivial query (below), then confirm that the visual changing the filter
re-runs the query and returns a changed `ANSWER_TEXT` row **in the Power BI Service**,
not just Desktop.

**Spike 2 — does the agent run from SQL?**
Confirm `SNOWFLAKE.CORTEX.DATA_AGENT_RUN(...)` runs `SPARTAN_TRENDS_CA` under
`SG_MSU_CORTEX_CHAT_PILOT` and returns text. The exact smoke query is at the top of
[`snowflake/data-agent-run.sql`](snowflake/data-agent-run.sql). Critically, the wrapper
procedure **must be `EXECUTE AS CALLER`** — agents run under the caller's role, and
owner's-rights agent execution is not supported.

## Build it (in order)

### 1. Snowflake

Run [`../snowflake/grant-existing-agent.sql`](../snowflake/grant-existing-agent.sql) first
(it sets up `SG_MSU_CORTEX_CHAT_PILOT` and the service identity — shared with Phase 2), then
[`snowflake/data-agent-run.sql`](snowflake/data-agent-run.sql) (the wrapper proc + answer
cache + grants). Do Spike 2 before moving on.

### 2. Wire up the Power BI model (the binding plumbing)

This is what turns "the visual changed a filter" into "Snowflake ran the agent and sent
an answer back." It has no UI in the visual - you build it once in Power BI Desktop. The
visual never touches Snowflake directly; this model wiring is the middleman.

You're building **three objects plus one binding** between them:

```
PromptParameter   a Text M parameter            -- carries the prompt value
PromptBinding     a tiny disconnected table     -- the visual filters its column
Answer query      a DirectQuery to Snowflake    -- CALLs the proc, passing the parameter

   binding:  PromptBinding[Prompt]  ──bound to──►  PromptParameter
```

`PromptBinding` and the answer query are **two separate queries**. `PromptBinding` does
**not** connect to Snowflake - it's hand-built, in-memory, zero rows. The only link
between the two is the parameter binding, a one-way value hand-off. Build them in this
order; each step depends on the one before it.

**Step 1 - Create the parameter `PromptParameter`** (Home → Manage Parameters → New).
Everything references it, so it comes first.

- **Type** = Text, **Required** = checked.
- **Suggested Values** = **Any value** (not "List of values" - that would block arbitrary
  prompt text from flowing through).
- **Current Value** = `__no_prompt__`. This is only the design-time default; the visual's
  filter overrides it at runtime. It's a sentinel on purpose: on initial load and on every
  scheduled refresh no question is selected, so the query runs with this default - and the
  stored proc short-circuits `__no_prompt__` to return no answer with **zero agent cost**
  (it never calls the agent on the sentinel). Don't put a real question here, or every
  refresh fires a billable agent run.

**Step 2 - Create the binding table `PromptBinding`.** Get Data → **Blank Query**, open the
Advanced Editor, and paste:

```m
// Query name: PromptBinding
let Source = #table(type table [Prompt = text], {}) in Source
```

Leave **Enable load** on so the column lands in the model. It loads as **Import** (a
`#table` can't be DirectQuery - that's fine and expected). Zero rows is deliberate: the
only way the column ever gets a value is the visual injecting one as a *filter*, not a **row.**

**Step 3 - Create the answer query** (DirectQuery). Connect to Snowflake and choose
**DirectQuery** (Import won't work for this). Keep the *source* line static and pass the
prompt as a **bound parameter** - never concatenate it into the source, or the Service will
refuse to refresh (see Gotchas):

```m
let
  Source = Snowflake.Databases("msu-prod.snowflakecomputing.com", "WHS_SPARTAN_TRENDS_AGENT"),
  Db     = Source{[Name="DBS_ANALYTICS_AI"]}[Data],
  Result = Value.NativeQuery(
             Db,
             "CALL DBS_ANALYTICS_AI.SPARTAN_TRENDS_AI.DATA_AGENT_RUN(?)",
             { PromptParameter },
             [EnableFolding = true])
in Result
```

It returns three columns: `ANSWER_TEXT`, `GENERATED_SQL`, `STATUS`. The connection
authenticates as the Service Principal / PAT from `grant-existing-agent.sql` (default role
`SG_MSU_CORTEX_CHAT_PILOT`). Your model now mixes Import (`PromptBinding`) and
DirectQuery (this query) - a composite model, which is exactly what dynamic M parameters need.

**Step 4 - Bind the column to the parameter.** In **Model view**, select
`PromptBinding[Prompt]` → Properties pane → **Advanced → Bind to parameter** → choose
`PromptParameter`, **Multi-select = No**. The column and parameter must be the same data
type (both Text). This dropdown only appears once the model has a DirectQuery source - so do
it after Step 3. If you don't see it, that's why.

**Step 5 - Sanity check before you touch the visual (this is Spike 1).** Prove the
round-trip fires: temporarily set the parameter's Current Value to a real question and
refresh the answer query - you should get a row with real `ANSWER_TEXT`. Set it back to
`__no_prompt__` and refresh - you should get `STATUS = IDLE` and a null answer (no agent
call). If both behave, the plumbing works and the visual just drives it from here.

> **No per-user RLS here.** Power BI row-level security is *not* supported alongside dynamic
> M query parameters, so everyone who opens the report sees answers scoped to the one shared
> role (`SG_MSU_CORTEX_CHAT_PILOT`). True per-user security is Phase 3 (Entra
> passthrough), not something RLS bolts onto Phase 1.

### 3. The visual

```bash
cd phase1/visual
npm install
npx pbiviz package        # builds dist/*.pbiviz
```

Import the `.pbiviz`, add it to the page, then:

- Bind your filter dimensions/measures (Region, Year, Category, …) to **Context fields**.
- Bind the answer query's `ANSWER_TEXT` column to **Answer text**.
- In **Format → Cortex Agent**, set **Prompt binding table** / **Prompt binding column**
  to match the names you used (defaults are `PromptBinding` / `Prompt`).

Ask a question. The bubble pulses while Snowflake runs, then fills in with the answer.

## How the pieces map

| Piece                                           | Where                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| Build the prompt + push it as a filter          | `src/visual.ts` → `send()`                      |
| Read the answer back out of the dataView        | `src/contextBuilder.ts` → `readAnswerText()`    |
| Serialize context (excluding the answer column) | `src/contextBuilder.ts` → `buildContextBlock()` |
| Run the agent + parse + cache                   | `snowflake/data-agent-run.sql`                  |
| Binding table / parameter / answer query        | the Power BI model (step 2 above)               |

## Gotchas (read before the demo)

- **Dynamic-data-source refresh error (Service-only).** If the prompt is concatenated into
  the connection or the source step, Power BI flags a "dynamic data source" and scheduled
  refresh fails *only in the Service* (Desktop looks fine). Keep the `Snowflake.Databases(...)`
  source static and pass the prompt as the `?` bound parameter, as above.
- **Native-query approval dialog.** SQL sources can pop "Require user approval for new native
  database queries" on every parameter change. Turn it off in **Options → Security** or the
  round-trip stalls on a modal mid-demo. This is the single most likely thing to break a live demo.
- **DirectQuery only**, **one question at a time**, **no streaming** (a spinner stands in), and
  **no memory** (each question is independent — there's no thread).
- **Repeated questions.** The answer cache returns identical answers fast; the visual renders the
  next answer on the following data update. If you ask the *exact* same question back-to-back, the
  refresh may not produce a new data update — change the question or a filter.
- **Charts/tables.** Phase 1 renders text answers (plus the agent's SQL if the proc returns it).
  Rich charts/tables were intentionally dropped here; that's Phase 2 territory.

## Security model

The Snowflake credential lives on the **Power BI dataset connection** (a Service Principal /
PAT), not in the visual and not in a proxy. Per-user visibility is Power BI row-level security
on top of that connection. The agent role stays read-only (`SG_MSU_CORTEX_CHAT_PILOT`), so a
prompt-injection attempt can't write. Same read-only posture as Phase 2, different plumbing.

## This is a throwaway demo

Phase 1 exists to show value fast while Phase 2 (the proxy + streaming chat) waits on security and
access approvals. When Phase 2 ships, this folder can be deleted. It deliberately does **not**
share code with Phase 2 — it was seeded from the Phase 2 visual and stripped down, so the two can
evolve independently without coordination.