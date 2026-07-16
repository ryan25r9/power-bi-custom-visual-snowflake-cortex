# Phase 1 postmortem (abandoned 2026-07-16)

Phase 1 was a proxy-free demo: the chat visual pushed the user's question into the
data model as a **filter**, a **Dynamic M query parameter** picked it up, and a
DirectQuery native SQL query ran `SNOWFLAKE.CORTEX.DATA_AGENT_RUN(...)` inline —
the answer came back to the visual as ordinary query data. No Azure, no middleware,
no streaming.

## Why it failed

Every link in the chain worked **except the one that mattered**:

- Proven working, individually: the M query and agent call (a filter-pane card
  resolved the parameter and returned an answer in seconds, timestamped), the
  visual's answer-rendering path, and the visual's filter — which persisted and
  propagated to other visuals correctly.
- The fatal link: a filter submitted by a **custom visual** never resolved the
  Dynamic M parameter. Ten test rounds isolated the cause: the Power BI host
  rewrites every visual-submitted filter — regardless of the shape the visual
  sends (Basic, Advanced, Identity/ChicletSlicer-style) — to
  `Basic In` with `requireSingleSelection: false`, which fails the documented
  single-select requirement for a Multi-select=No parameter binding. Native
  slicers and the filter pane satisfy the requirement; the visual-filter API
  cannot.

The only untested workaround (Multi-select=Yes binding + list-tolerant M) was
overtaken by the decision to build Phase 2 properly. Even if it had worked, the
design ceiling was low: no streaming, no conversation memory, one Snowflake role
for all users, and answers limited to what fits in a query result.

## What Phase 2 keeps from it

- The **report-context idea** (serialize what the user is looking at into the
  prompt) predates Phase 1 and lives on in `visual/src/contextBuilder.ts`.
- The failure is a permanent design constraint worth remembering: **a Power BI
  custom visual cannot drive a Dynamic M query parameter**. Any future "no
  middleware" revival hits the same wall.

The Phase 1 code (`phase1/` — its own pbiviz project, tests, and an 800-line
debugging log) was removed when Phase 2 became the sole focus. It exists in git
history before this commit if archaeology is ever needed.
