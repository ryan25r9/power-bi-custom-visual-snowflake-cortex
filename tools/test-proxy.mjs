/**
 * End-to-end tests for the compiled Azure Function SSE relay (proxy/dist)
 * against the local mock Snowflake server (tools/mock-snowflake.mjs, :8043).
 *
 * No frameworks — node:assert only. Run via tools/run-e2e.sh.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- env must be in place BEFORE importing the compiled handler ---
process.env.SNOWFLAKE_ACCOUNT_URL = "http://127.0.0.1:8043";
process.env.SNOWFLAKE_PAT = "TEST_PAT";
process.env.AGENT_DATABASE = "AI_DB";
process.env.AGENT_SCHEMA = "AGENTS";
process.env.AGENT_NAME = "REPORT_CHAT_AGENT";
process.env.PROXY_API_KEY = "k123";
process.env.ALLOWED_ORIGINS = "https://app.powerbi.com";

const here = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.join(here, "..", "proxy", "dist", "src", "functions", "agentProxy.js");
const mod = await import(pathToFileURL(compiled).href);
const agentHandler = mod.agentHandler ?? mod.default?.agentHandler;
assert.equal(typeof agentHandler, "function",
    "agentHandler must be exported from the compiled module (standalone import)");

// --- minimal fakes ---
const ORIGIN = "https://app.powerbi.com";
const ctx = { log: () => {}, warn: () => {}, error: () => {} };
function makeReq({ method = "POST", headers = {}, body } = {}) {
    return {
        method,
        headers: new Headers(headers), // real Headers: case-insensitive .get()
        json: async () => {
            if (body === undefined) throw new Error("no body");
            return body;
        }
    };
}
const GOOD_BODY = { messages: [{ role: "user", content: [{ type: "text", text: "top regions by sales" }] }] };

let failures = 0;
async function test(label, fn) {
    try {
        await fn();
        console.log(`PASS ${label}`);
    } catch (e) {
        failures++;
        console.error(`FAIL ${label}`);
        console.error(e && e.stack ? e.stack : e);
    }
}

// (a) OPTIONS preflight
await test("a. OPTIONS preflight -> 204 + CORS", async () => {
    const res = await agentHandler(makeReq({ method: "OPTIONS", headers: { origin: ORIGIN } }), ctx);
    assert.equal(res.status, 204);
    assert.equal(res.headers["Access-Control-Allow-Origin"], ORIGIN);
    assert.ok(res.headers["Access-Control-Allow-Headers"].includes("x-proxy-key"),
        "Allow-Headers must list x-proxy-key");
});

// (b) bad/missing proxy key
await test("b. POST wrong/missing x-proxy-key -> 401", async () => {
    const wrong = await agentHandler(
        makeReq({ headers: { origin: ORIGIN, "x-proxy-key": "nope" }, body: GOOD_BODY }), ctx);
    assert.equal(wrong.status, 401);
    const missing = await agentHandler(
        makeReq({ headers: { origin: ORIGIN }, body: GOOD_BODY }), ctx);
    assert.equal(missing.status, 401);
});

// (c) missing messages[]
await test("c. POST missing messages -> 400", async () => {
    const res = await agentHandler(
        makeReq({ headers: { origin: ORIGIN, "x-proxy-key": "k123" }, body: { foo: 1 } }), ctx);
    assert.equal(res.status, 400);
});

// (d) happy path — relay streams SSE through, chunk by chunk
await test("d. happy path -> 200 SSE, streamed, framing intact", async () => {
    const res = await agentHandler(
        makeReq({ headers: { origin: ORIGIN, "x-proxy-key": "k123" }, body: GOOD_BODY }), ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers["Content-Type"], "text/event-stream");
    assert.equal(res.headers["Access-Control-Allow-Origin"], ORIGIN);
    assert.ok(res.body, "response must carry the upstream body stream");

    // read chunk-by-chunk; the mock's ~80ms gaps mean a true relay yields many reads
    const dec = new TextDecoder();
    let reads = 0;
    let text = "";
    for await (const chunk of res.body) {
        reads++;
        text += dec.decode(chunk, { stream: true });
    }
    text += dec.decode();
    assert.ok(reads >= 3, `expected >=3 separate reads (streaming, not buffering); got ${reads}`);

    // content assertions
    assert.ok(text.includes("event: response.text.delta"), "text.delta event missing");
    assert.ok(text.includes("SELECT region, SUM(sales) s FROM t GROUP BY 1 ORDER BY 2 DESC"), "SQL missing");
    assert.ok(text.includes("chart_spec"), "chart_spec missing");

    // SSE framing preserved verbatim: 15 well-formed "event:/data:" blocks split by \n\n
    assert.ok(text.endsWith("\n\n"), "stream must end with an event terminator");
    const blocks = text.split("\n\n").filter(b => b.length > 0);
    assert.equal(blocks.length, 15, `expected 15 SSE events, got ${blocks.length}`);
    for (const b of blocks) {
        assert.match(b, /^event: [a-z_.]+\ndata: \{.+\}$/,
            `malformed SSE block: ${JSON.stringify(b.slice(0, 80))}`);
    }
    assert.equal(blocks[0], 'event: response.status\ndata: {"message":"Planning the next steps","status":"planning"}');
    assert.equal(blocks.filter(b => b.startsWith("event: response.text.delta\n")).length, 4);
});

// (e) upstream auth failure passes through as snowflake_error
await test("e. upstream 401 -> non-200 + jsonBody.error snowflake_error", async () => {
    process.env.SNOWFLAKE_PAT = "WRONG";
    try {
        const res = await agentHandler(
            makeReq({ headers: { origin: ORIGIN, "x-proxy-key": "k123" }, body: GOOD_BODY }), ctx);
        assert.notEqual(res.status, 200);
        assert.equal(res.status, 401, "upstream status should pass through");
        assert.equal(res.jsonBody.error, "snowflake_error");
    } finally {
        process.env.SNOWFLAKE_PAT = "TEST_PAT";
    }
});

// (f) empty PROXY_API_KEY must fail closed
await test("f. empty PROXY_API_KEY -> 401 even with matching empty header", async () => {
    process.env.PROXY_API_KEY = "";
    try {
        const res = await agentHandler(
            makeReq({ headers: { origin: ORIGIN, "x-proxy-key": "" }, body: GOOD_BODY }), ctx);
        assert.equal(res.status, 401, "must fail closed when PROXY_API_KEY is unset/empty");
    } finally {
        process.env.PROXY_API_KEY = "k123";
    }
});

if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
}
console.log("\nAll tests passed");
