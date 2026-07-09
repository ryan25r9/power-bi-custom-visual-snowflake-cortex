/**
 * Unit tests for phase1/visual/src/contextBuilder.ts.
 * The one piece of non-trivial logic here is that the returned "Answer text"
 * column must be EXCLUDED from the serialized context — otherwise the previous
 * answer leaks into the next question's prompt.
 *
 * Compile first: phase1/visual/node_modules/.bin/tsc -p phase1/visual/tests/tsconfig.json
 * (or just run phase1/visual/tests/run-tests.sh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextBlock, readAnswerText, detectInputMode, findPromptSource, buildPromptFilter } from "./build/contextBuilder.js";

/** Fake DataView. cols: [{displayName, isMeasure?, answer?}]; answer:true tags the answerText role. */
function makeDataView(cols, rows) {
    return {
        table: {
            columns: cols.map(c => ({
                displayName: c.displayName,
                isMeasure: !!c.isMeasure,
                roles: c.answer ? { answerText: true } : { contextFields: true }
            })),
            rows
        }
    };
}

test("1. answer column is excluded from context fields AND data rows", () => {
    const dv = makeDataView(
        [{ displayName: "Region" }, { displayName: "Sales", isMeasure: true }, { displayName: "Reply", answer: true }],
        [["West", 100, "West leads all regions."]]
    );
    const { block, summary } = buildContextBlock(dv, 10, "");

    assert.equal(summary.fieldCount, 2, "only the two context columns are counted");
    assert.ok(block.includes("Fields in view: Region, Sales (measure)"), "context lists Region + Sales, not the answer");
    assert.ok(!block.includes("Reply"), "the answer column header must not appear in context");
    assert.ok(!block.includes("West leads all regions"), "the answer value must not leak into context");

    const dataRow = block.split("\n").find(l => /^West,/.test(l));
    assert.equal(dataRow, "West,100", "data row carries only the context cells");
});

test("2. readAnswerText returns the first non-empty cell of the answerText column", () => {
    const dv = makeDataView(
        [{ displayName: "Region" }, { displayName: "Reply", answer: true }],
        [["West", ""], ["East", "East is up 12% YoY."]]
    );
    assert.equal(readAnswerText(dv), "East is up 12% YoY.");
});

test("3. readAnswerText returns null when no answer column is bound", () => {
    const dv = makeDataView([{ displayName: "Region" }], [["West"]]);
    assert.equal(readAnswerText(dv), null);
    assert.equal(readAnswerText(undefined), null);
});

test("4. truncation: 5 rows, maxRows 2 -> '2 of 5' and '3 more rows'", () => {
    const dv = makeDataView(
        [{ displayName: "Region" }, { displayName: "Reply", answer: true }],
        Array.from({ length: 5 }, (_, i) => [`R${i}`, "ans"])
    );
    const { block, summary } = buildContextBlock(dv, 2, "");
    assert.equal(summary.rowCount, 5);
    assert.equal(summary.truncated, true);
    assert.ok(block.includes("2 of 5"));
    assert.ok(block.includes("3 more rows"));
});

test("5. CSV escaping: commas/quotes in a context value are quoted", () => {
    const dv = makeDataView(
        [{ displayName: "Name" }, { displayName: "Reply", answer: true }],
        [['a,b "c"', "ans"]]
    );
    const { block } = buildContextBlock(dv, 10, "");
    assert.ok(block.includes('"a,b ""c"""'), "comma + embedded quotes escaped per CSV rules");
});

test("6. no context fields bound -> explanatory line, fieldCount 0", () => {
    const dv = makeDataView([{ displayName: "Reply", answer: true }], [["just an answer"]]);
    const { block, summary } = buildContextBlock(dv, 10, "");
    assert.equal(summary.fieldCount, 0);
    assert.ok(/no context fields are bound/i.test(block));
    assert.ok(!block.includes("just an answer"), "answer still excluded even when it's the only column");
});

// ---------- input-mode detection (two-instance design) ----------

const promptCol = { displayName: "Prompt", queryName: "PromptBinding.Prompt", roles: { promptField: true } };

/** Categorical dataView as the host delivers it for the input-only instance. */
function inputDv({ withMetadata = true, withCategories = true } = {}) {
    return {
        metadata: { columns: withMetadata ? [promptCol] : [] },
        categorical: withCategories ? { categories: [{ source: promptCol, values: [] }] } : {}
    };
}

/** Table dataView for a display instance (answer + optional context bound). */
function displayDv() {
    return {
        metadata: { columns: [{ displayName: "Reply", roles: { answerText: true } }] },
        table: { columns: [{ displayName: "Reply", roles: { answerText: true } }], rows: [] }
    };
}

test("7. detectInputMode: prompt column bound alone -> input mode", () => {
    assert.equal(detectInputMode([inputDv()], false), true);
});

test("8. detectInputMode: zero-row edge — categorical shape with EMPTY metadata still detects", () => {
    // The binding table has no rows; the host may deliver the categorical dataView
    // with no metadata columns at all. Shape (categorical, no table) must suffice.
    assert.equal(detectInputMode([inputDv({ withMetadata: false, withCategories: false })], false), true);
});

test("9. detectInputMode: answer text bound -> display mode, even if prompt is also bound", () => {
    assert.equal(detectInputMode([displayDv()], false), false);
    const combo = displayDv();
    combo.metadata.columns.push(promptCol);
    assert.equal(detectInputMode([combo], false), false, "combo (Test-A shape) instances stay display");
});

test("10. detectInputMode: nothing bound -> display mode; forced flag overrides everything", () => {
    assert.equal(detectInputMode([], false), false);
    assert.equal(detectInputMode(undefined, false), false);
    assert.equal(detectInputMode(undefined, true), true, "format-pane Force input mode is the backstop");
});

test("11. findPromptSource: prefers the categorical source, falls back to metadata, else undefined", () => {
    assert.equal(findPromptSource([inputDv()])?.queryName, "PromptBinding.Prompt");
    const metaOnly = { metadata: { columns: [promptCol] } };
    assert.equal(findPromptSource([displayDv(), metaOnly])?.queryName, "PromptBinding.Prompt",
        "scans past dataViews that lack the role");
    assert.equal(findPromptSource([displayDv()]), undefined);
});

test("12. buildPromptFilter emits the slicer-canonical shape (Basic In, one value, single-select)", () => {
    const f = buildPromptFilter("PromptBinding", "Prompt", "What changed?");
    assert.equal(f.$schema, "http://powerbi.com/product/schema#basic");
    assert.deepEqual(f.target, { table: "PromptBinding", column: "Prompt" });
    assert.equal(f.filterType, 1, "FilterType.Basic");
    assert.equal(f.operator, "In");
    assert.deepEqual(f.values, ["What changed?"]);
    assert.equal(f.requireSingleSelection, true,
        "Dynamic M docs require single-select semantics when the binding is Multi-select=No");
});
