/**
 * Static checks on capabilities.json.
 *
 * Regression for the 1.0.5.0 field bug: with only the prompt field bound, TWO
 * dataViewMappings condition sets matched at once (the table mapping said just
 * "promptField max 1"). Desktop threw "an error occurred while rendering" and
 * the instance never entered input mode. Condition sets must be MUTUALLY
 * EXCLUSIVE for every reachable field-well combination.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const caps = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "capabilities.json"), "utf8"));

const ROLES = ["promptField", "contextFields", "answerText"];

/** A condition set matches when every constrained role's count is within [min, max]. */
function matches(cond, counts) {
    return Object.entries(cond).every(([role, c]) =>
        (c.min === undefined || counts[role] >= c.min) &&
        (c.max === undefined || counts[role] <= c.max));
}

function matchingMappings(counts) {
    return caps.dataViewMappings.filter(m =>
        (m.conditions ?? []).some(cond => matches(cond, counts)));
}

test("1. condition sets are mutually exclusive for every binding combination", () => {
    for (const promptField of [0, 1]) {
        for (const answerText of [0, 1, 2]) {
            for (const contextFields of [0, 1, 2, 5]) {
                const counts = { promptField, answerText, contextFields };
                const n = matchingMappings(counts).length;
                assert.ok(n <= 1,
                    `${JSON.stringify(counts)} matches ${n} mappings — overlapping conditions broke input mode in 1.0.5.0`);
            }
        }
    }
});

test("2. prompt-only binding selects the categorical (input-mode) mapping", () => {
    const m = matchingMappings({ promptField: 1, answerText: 0, contextFields: 0 });
    assert.equal(m.length, 1, "exactly one mapping must match the input-only instance");
    assert.ok(m[0].categorical, "and it must be the categorical one (drives input-mode detection)");
});

test("3. display and combo bindings select a table mapping", () => {
    for (const counts of [
        { promptField: 0, answerText: 1, contextFields: 3 },  // display instance
        { promptField: 0, answerText: 0, contextFields: 0 },  // freshly added, nothing bound
        { promptField: 1, answerText: 1, contextFields: 0 }   // Test-A-shaped leftover
    ]) {
        const m = matchingMappings(counts);
        assert.equal(m.length, 1, `${JSON.stringify(counts)} must match exactly one mapping`);
        assert.ok(m[0].table, `${JSON.stringify(counts)} must get the table mapping`);
    }
});

test("4. the prompt column is never projected into a table mapping", () => {
    // Projecting the zero-row binding column into the answer query would cross-join
    // it in and blank the whole dataView — the answer could never render.
    for (const m of caps.dataViewMappings.filter(m => m.table)) {
        const projected = m.table.rows.select.map(s => s.for?.in);
        assert.ok(!projected.includes("promptField"),
            "table mappings must select only contextFields/answerText");
    }
});

test("5. roles referenced by mappings and conditions all exist", () => {
    const declared = new Set(caps.dataRoles.map(r => r.name));
    for (const role of ROLES) assert.ok(declared.has(role), `role ${role} declared`);
    for (const m of caps.dataViewMappings) {
        for (const cond of m.conditions ?? []) {
            for (const role of Object.keys(cond)) {
                assert.ok(declared.has(role), `condition references undeclared role ${role}`);
            }
        }
    }
});
