/**
 * Unit tests for visual/src/contextBuilder.ts — buildContextBlock().
 * Compile first with: proxy/node_modules/.bin/tsc -p tests/tsconfig.json
 * (or just run tests/run-tests.sh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextBlock } from "./build/contextBuilder.js";

/** Minimal fake powerbi.DataView with a table mapping. */
function makeDataView(columnNames, rows, measureFlags = []) {
    return {
        table: {
            columns: columnNames.map((displayName, i) => ({
                displayName,
                isMeasure: !!measureFlags[i]
            })),
            rows
        }
    };
}

test("1. truncation: 10 rows with maxRows=3 -> '3 of 10', '7 more rows', summary truncated", () => {
    const dv = makeDataView(
        ["Region", "Sales"],
        Array.from({ length: 10 }, (_, i) => [`R${i}`, i * 100])
    );
    const { block, summary } = buildContextBlock(dv, undefined, 3, "");

    assert.equal(summary.rowCount, 10);
    assert.equal(summary.truncated, true);
    assert.equal(summary.fieldCount, 2);
    assert.ok(block.includes("3 of 10"), "block should announce '3 of 10' rows");
    assert.ok(block.includes("7 more rows"), "block should mention '7 more rows'");

    // Exactly 3 data rows were emitted (R0..R2), none beyond.
    const dataRows = block.split("\n").filter(l => /^R\d+,/.test(l));
    assert.deepEqual(dataRows, ["R0,0", "R1,100", "R2,200"]);
});

test("2. CSV escaping: comma, double-quote, newline values are quoted / doubled", () => {
    const dv = makeDataView(
        ["Name, First", "Quote", "Multi"],
        [["a,b", 'say "hi"', "line1\nline2"]]
    );
    const { block } = buildContextBlock(dv, undefined, 10, "");

    assert.ok(block.includes('"Name, First"'), "header containing a comma must be quoted");
    assert.ok(block.includes('"a,b"'), "value containing a comma must be quoted");
    assert.ok(block.includes('"say ""hi"""'), "embedded double-quotes must be doubled inside a quoted field");
    assert.ok(block.includes('"line1\nline2"'), "value containing a newline must be quoted (newline preserved)");

    // The full data row, escaped end-to-end.
    assert.ok(block.includes('"a,b","say ""hi""","line1\nline2"'), "entire row should round-trip as valid CSV");
});

test("3. undefined dataView -> block still produced, fieldCount 0, mentions no fields bound", () => {
    const { block, summary } = buildContextBlock(undefined, undefined, 50, "");

    assert.equal(summary.fieldCount, 0);
    assert.equal(summary.rowCount, 0);
    assert.equal(summary.truncated, false);
    assert.equal(summary.filterCount, 0);
    assert.ok(block.includes("=== POWER BI REPORT CONTEXT ==="), "header present even with no data");
    assert.ok(block.includes("=== END CONTEXT ==="), "footer present even with no data");
    assert.ok(/no fields are bound/i.test(block), "should state that no fields are bound");
});

test("4. columns bound but zero rows -> 'returns no rows', truncated false", () => {
    const dv = makeDataView(["Sales"], [], [true]);
    const { block, summary } = buildContextBlock(dv, undefined, 50, "");

    assert.equal(summary.fieldCount, 1);
    assert.equal(summary.rowCount, 0);
    assert.equal(summary.truncated, false);
    assert.ok(block.includes("returns no rows"), "should explain the empty result");
    assert.ok(block.includes("Sales (measure)"), "measure flag should be reflected in the field list");
    assert.ok(!block.includes("0 of 0"), "no CSV header section for an empty table");
});

test("5. Date value -> ISO yyyy-mm-dd; null -> empty string", () => {
    const dv = makeDataView(
        ["When", "What"],
        [[new Date(Date.UTC(2024, 0, 15, 12, 30, 45)), null]]
    );
    const { block } = buildContextBlock(dv, undefined, 10, "");

    const lines = block.split("\n");
    assert.ok(
        lines.includes("2024-01-15,"),
        `expected exact data row '2024-01-15,' (ISO date, empty string for null); got:\n${block}`
    );
    assert.ok(!block.includes("T12:30"), "time portion must be stripped from the ISO date");
});

test("6. jsonFilters: filterCount set + JSON included; giant filter truncated with ellipsis", () => {
    const filters = [{
        $schema: "http://powerbi.com/product/schema#basic",
        target: { table: "Sales", column: "Region" },
        operator: "In",
        values: ["West"]
    }];
    const r1 = buildContextBlock(undefined, filters, 10, "");
    assert.equal(r1.summary.filterCount, 1);
    assert.ok(r1.block.includes("Active filters"), "filter section present");
    assert.ok(r1.block.includes(JSON.stringify(filters)), "small filter JSON included verbatim");

    // Giant filter: serialized length > 2000 -> hard cut at 2000 chars + ellipsis character.
    const giant = [{ values: ["A".repeat(2500) + "ZZZ_END_MARKER"] }];
    const r2 = buildContextBlock(undefined, giant, 10, "");
    assert.equal(r2.summary.filterCount, 1);
    assert.ok(r2.block.includes("…"), "truncated filter JSON must contain the ellipsis character");
    assert.ok(!r2.block.includes("ZZZ_END_MARKER"), "tail of the giant filter must be cut off");
    const line = r2.block.split("\n").find(l => l.startsWith("Active filters"));
    const json = line.slice(line.indexOf(":") + 2);
    assert.equal(json.length, 2001, "2000 kept chars + 1 ellipsis char");

    // Empty / missing filter arrays leave filterCount 0 and add no section.
    const r3 = buildContextBlock(undefined, [], 10, "");
    assert.equal(r3.summary.filterCount, 0);
    assert.ok(!r3.block.includes("Active filters"));
});

test("7. reportHint appears in block when non-empty, absent when empty", () => {
    const hint = "Quarterly revenue dashboard for EMEA";
    const withHint = buildContextBlock(undefined, undefined, 10, hint);
    assert.ok(withHint.block.includes(`Report description: ${hint}`));

    const noHint = buildContextBlock(undefined, undefined, 10, "");
    assert.ok(!noHint.block.includes("Report description:"));
});
