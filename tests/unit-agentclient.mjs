/**
 * Unit tests for visual/src/agentClient.ts — streamAgent() (incl. the private
 * SSE parser handleBlock, exercised through the stream) and findVegaSpec().
 * Compile first with: proxy/node_modules/.bin/tsc -p tests/tsconfig.json
 * (or just run tests/run-tests.sh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { streamAgent, streamAgentWithRetry, findVegaSpec } from "./build/agentClient.js";

const enc = new TextEncoder();

/** A real ReadableStream of byte chunks (strings are UTF-8 encoded). */
function streamFromChunks(chunks) {
    let i = 0;
    return new ReadableStream({
        pull(controller) {
            if (i < chunks.length) {
                const c = chunks[i++];
                controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
            } else {
                controller.close();
            }
        }
    });
}

/** Records every callback invocation in order. */
function recorder() {
    const calls = [];
    return {
        calls,
        text: () => calls.filter(c => c[0] === "text").map(c => c[1]).join(""),
        of: kind => calls.filter(c => c[0] === kind),
        cb: {
            onStatus: m => calls.push(["status", m]),
            onTextDelta: t => calls.push(["text", t]),
            onThinkingDelta: t => calls.push(["thinking", t]),
            onToolUse: (name, toolType) => calls.push(["tool_use", name, toolType]),
            onToolStatus: m => calls.push(["tool_status", m]),
            onSql: s => calls.push(["sql", s]),
            onChart: s => calls.push(["chart", s]),
            onDone: () => calls.push(["done"]),
            onError: e => calls.push(["error", e]),
            onWarning: m => calls.push(["warning", m]),
            onAnnotation: a => calls.push(["annotation", a]),
            onTable: t => calls.push(["table", t])
        }
    };
}

const MESSAGES = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

/** Default AgentConnection used by most tests (shared-key mode, like v1). */
const CONN = {
    url: "https://proxy.example/agent",
    authMode: "key",
    credential: "key123",
    conversationId: "conv-abc123"
};

/** Runs streamAgent against a mocked globalThis.fetch resolving to a Response-like object. */
async function runStream(respPatch, connPatch = {}) {
    const rec = recorder();
    const resp = { ok: true, status: 200, ...respPatch };
    const origFetch = globalThis.fetch;
    const fetches = [];
    globalThis.fetch = async (url, init) => { fetches.push({ url, init }); return resp; };
    try {
        await streamAgent(
            { ...CONN, ...connPatch },
            MESSAGES,
            rec.cb,
            new AbortController().signal
        );
    } finally {
        globalThis.fetch = origFetch;
    }
    rec.fetchCalls = fetches;
    return rec;
}

const HAPPY_SSE =
    "event: response.status\n" +
    'data: {"message":"Planning request","status":"planning"}\n' +
    "\n" +
    "event: response.text.delta\n" +
    'data: {"content_index":0,"text":"Hello"}\n' +
    "\n" +
    "event: response.text.delta\n" +
    'data: {"content_index":0,"text":", "}\n' +
    "\n" +
    "event: response.text.delta\n" +
    'data: {"content_index":0,"text":"world"}\n' +
    "\n";

const HAPPY_EXPECTED = [
    ["status", "Planning request"],
    ["text", "Hello"],
    ["text", ", "],
    ["text", "world"],
    ["done"]
];

test("8. happy path: response.status + 3 text deltas, in order, then done", async () => {
    const rec = await runStream({ body: streamFromChunks([HAPPY_SSE]) });
    assert.deepEqual(rec.calls, HAPPY_EXPECTED);
    assert.equal(rec.text(), "Hello, world");
});

test("9. chunk boundary torture: mid-line, mid-JSON, separator split across chunks -> identical to test 8", async () => {
    // Handcrafted nasty cut points inside the exact byte stream of test 8.
    const idx = (s, off = 0) => {
        const i = HAPPY_SSE.indexOf(s);
        assert.ok(i >= 0, `fixture must contain ${JSON.stringify(s)}`);
        return i + off;
    };
    const cuts = [...new Set([
        idx("event: response.status", 10),          // mid "event:" line, inside the event name
        idx('"message":"Planning request"', 15),    // mid-JSON, inside a string value
        idx("\n\nevent: response.text.delta", 1),   // the \n\n separator split across two chunks
        idx('"content_index":0,"text":"Hello"', 5), // mid-JSON, inside a key
        HAPPY_SSE.lastIndexOf("\n\n") + 1           // final separator split too
    ])].sort((a, b) => a - b);

    const chunks = [];
    let prev = 0;
    for (const c of cuts) {
        chunks.push(HAPPY_SSE.slice(prev, c));
        prev = c;
    }
    chunks.push(HAPPY_SSE.slice(prev));
    assert.equal(chunks.join(""), HAPPY_SSE, "splitting must be lossless");

    const rec = await runStream({ body: streamFromChunks(chunks) });
    assert.deepEqual(rec.calls, HAPPY_EXPECTED, "handcrafted splits must not change callback results");

    // Ultimate torture: one byte per chunk = every possible boundary at once.
    const oneByteChunks = Array.from(enc.encode(HAPPY_SSE), b => new Uint8Array([b]));
    const rec2 = await runStream({ body: streamFromChunks(oneByteChunks) });
    assert.deepEqual(rec2.calls, HAPPY_EXPECTED, "1-byte chunks must not change callback results");
});

test("10. CRLF (\\r\\n) framing instead of \\n still parses", async () => {
    const crlf = HAPPY_SSE.replace(/\n/g, "\r\n");
    const rec = await runStream({ body: streamFromChunks([crlf]) });
    assert.deepEqual(rec.calls, HAPPY_EXPECTED);

    // And with the \r\n\r\n separator split across two chunks ("...\r\n\r" | "\n...").
    const cut = crlf.indexOf("\r\n\r\n") + 3;
    const rec2 = await runStream({
        body: streamFromChunks([crlf.slice(0, cut), crlf.slice(cut)])
    });
    assert.deepEqual(rec2.calls, HAPPY_EXPECTED);
});

test("11. 401 response -> onError('AUTH') exactly, no other callbacks", async () => {
    const rec = await runStream({ ok: false, status: 401, body: null });
    assert.deepEqual(rec.calls, [["error", "AUTH"]]);

    // 403 uses the same sentinel.
    const rec403 = await runStream({ ok: false, status: 403, body: null });
    assert.deepEqual(rec403.calls, [["error", "AUTH"]]);
});

test("12. non-OK 500 with text body -> onError contains '500'", async () => {
    const rec = await runStream({
        ok: false,
        status: 500,
        body: null,
        text: async () => "internal proxy kaboom"
    });
    assert.equal(rec.calls.length, 1, "exactly one callback expected");
    const [kind, msg] = rec.calls[0];
    assert.equal(kind, "error");
    assert.ok(msg.includes("500"), `error message should contain the status code; got: ${msg}`);
    assert.ok(msg.includes("internal proxy kaboom"), "error message should include the response text");
});

test("13. unknown event types interleaved -> ignored, no throw, known events still fire", async () => {
    const sse =
        'event: response.metadata\ndata: {"foo":1}\n\n' +
        "event: weird.future.event\ndata: this is not json {{\n\n" +
        "event: ping\n\n" +                                  // no data line at all
        'data: {"text":"event-less data line"}\n\n' +        // data with no event name
        'event: response.text.delta\ndata: {"text":"still here"}\n\n';
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [["text", "still here"], ["done"]]);
});

test("14. tool_use -> onToolUse; tool_result.status -> onToolStatus; tool_result -> onSql / onChart", async () => {
    const spec = {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        mark: "bar",
        encoding: { x: { field: "REGION" }, y: { field: "SALES" } }
    };
    const sse =
        'event: response.tool_use\ndata: {"type":"system_execute_sql","name":"Analyst1","input":{}}\n\n' +
        'event: response.tool_result.status\ndata: {"status":"executing","message":"Executing SQL..."}\n\n' +
        'event: response.tool_result\ndata: {"name":"Analyst1","content":[{"type":"json","json":{"sql":"SELECT REGION, SUM(SALES) FROM T GROUP BY 1","text":"interpretation"}}]}\n\n' +
        `event: response.tool_result\ndata: {"name":"Chart1","content":[{"type":"json","json":{"chart_spec":${JSON.stringify(spec)}}}]}\n\n`;
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [
        ["tool_use", "Analyst1", "system_execute_sql"],
        ["tool_status", "Executing SQL..."],
        ["sql", "SELECT REGION, SUM(SALES) FROM T GROUP BY 1"],
        ["chart", spec],
        ["done"]
    ]);
});

test("15. AbortError mid-stream -> NO onError (and no onDone)", async () => {
    let reads = 0;
    const body = {
        getReader: () => ({
            read() {
                reads++;
                if (reads === 1) {
                    return Promise.resolve({
                        done: false,
                        value: enc.encode('event: response.text.delta\ndata: {"text":"partial"}\n\n')
                    });
                }
                return Promise.reject({ name: "AbortError", message: "The user aborted a request." });
            }
        })
    };
    const rec = await runStream({ body });
    assert.deepEqual(rec.of("error"), [], "abort must not surface as an error");
    assert.deepEqual(rec.of("done"), [], "aborted stream must not report done");
    assert.deepEqual(rec.of("text"), [["text", "partial"]], "content before the abort is still delivered");
});

test("16. trailing block without final \\n\\n is parsed at stream end (buffer flush)", async () => {
    const sse =
        'event: response.text.delta\ndata: {"text":"head"}\n\n' +
        'event: response.text.delta\ndata: {"text":"tail"}'; // no trailing blank line
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [["text", "head"], ["text", "tail"], ["done"]]);
});

test("17. data: [DONE] -> ignored silently", async () => {
    const sse =
        'event: response.text.delta\ndata: {"text":"x"}\n\n' +
        "data: [DONE]\n\n";
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [["text", "x"], ["done"]]);
});

test("18. findVegaSpec recognition matrix", () => {
    const vega = {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        mark: "bar",
        encoding: {},
        data: { values: [] }
    };
    const bare = { mark: "line", encoding: { x: { field: "d" } } };

    // Direct spec with a vega $schema -> returned (same reference).
    assert.equal(findVegaSpec(vega), vega);

    // {mark, encoding} without $schema -> still recognized.
    assert.equal(findVegaSpec(bare), bare);

    // Nested one level under chart_spec -> found.
    assert.equal(findVegaSpec({ chart_spec: vega }), vega);

    // JSON-string-encoded spec -> parsed and found.
    assert.deepEqual(findVegaSpec(JSON.stringify(vega)), vega);

    // Plain non-chart object -> null.
    assert.equal(findVegaSpec({ answer: 42 }), null);

    // Nesting deeper than depth 2 -> null...
    assert.equal(findVegaSpec({ spec: { spec: { spec: bare } } }), null);
    // ...but exactly depth 2 still works.
    assert.equal(findVegaSpec({ spec: { chart_spec: bare } }), bare);
});

test("19. legacy cortex_analyst_text_to_sql blocks still parse (pre-Apr-2026 back-compat)", async () => {
    const sse =
        'event: response.tool_use\ndata: {"type":"cortex_analyst_text_to_sql","name":"Analyst1","input":{}}\n\n' +
        'event: response.tool_result\ndata: {"name":"Analyst1","content":[{"type":"json","json":{"sql":"SELECT 1","text":"legacy"}}]}\n\n';
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [
        ["tool_use", "Analyst1", "cortex_analyst_text_to_sql"],
        ["sql", "SELECT 1"],
        ["done"]
    ]);
});

test("20. response.warning -> onWarning", async () => {
    const sse =
        'event: response.warning\ndata: {"message":"Result truncated"}\n\n' +
        'event: response.text.delta\ndata: {"text":"hi"}\n\n';
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [["warning", "Result truncated"], ["text", "hi"], ["done"]]);
});

test("21. response.text.annotation -> onAnnotation with the annotation object", async () => {
    const ann = { type: "cortex_search_citation", doc_id: "doc_42", doc_title: "Sales Playbook", text: "West leads." };
    const sse = `event: response.text.annotation\ndata: ${JSON.stringify({ content_index: 0, annotation_index: 0, annotation: ann })}\n\n`;
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [["annotation", ann], ["done"]]);
});

test("22. response.chart -> onChart for nested-object AND json-string chart_spec", async () => {
    const spec = { $schema: "https://vega.github.io/schema/vega-lite/v5.json", mark: "bar", encoding: {} };
    const sse =
        `event: response.chart\ndata: ${JSON.stringify({ content_index: 4, chart: { chart_spec: spec } })}\n\n` +
        `event: response.chart\ndata: ${JSON.stringify({ content_index: 5, chart: { chart_spec: JSON.stringify(spec) } })}\n\n`;
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [["chart", spec], ["chart", spec], ["done"]]);
});

test("23. response.table -> onTable {columns, rows} from the SQL REST result_set shape", async () => {
    const payload = {
        content_index: 3,
        result_set: { resultSetMetaData: { rowType: [{ name: "REGION" }, { name: "SALES" }] }, data: [["West", "100"], ["East", "80"]] }
    };
    const sse =
        `event: response.table\ndata: ${JSON.stringify(payload)}\n\n` +
        'event: response.table\ndata: {"result_set":{"no":"metadata"}}\n\n'; // malformed -> ignored
    const rec = await runStream({ body: streamFromChunks([sse]) });
    assert.deepEqual(rec.calls, [
        ["table", { columns: ["REGION", "SALES"], rows: [["West", "100"], ["East", "80"]] }],
        ["done"]
    ]);
});

// --- streamAgentWithRetry ---------------------------------------------------

/** Runs streamAgentWithRetry against fetch returning each response in turn (1ms backoff base). */
async function runRetryStream(responses, { maxRetries = 2 } = {}) {
    const rec = recorder();
    let fetches = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const r = responses[Math.min(fetches, responses.length - 1)];
        fetches++;
        if (r instanceof Error) throw r;
        return { ok: true, status: 200, ...r };
    };
    try {
        await streamAgentWithRetry(
            CONN, MESSAGES,
            rec.cb, new AbortController().signal, maxRetries, 1
        );
    } finally {
        globalThis.fetch = origFetch;
    }
    return { rec, fetches: () => fetches };
}

test("24. transient 502 then success -> retried once, content delivered, no onError", async () => {
    const good = { body: streamFromChunks(['event: response.text.delta\ndata: {"text":"ok"}\n\n']) };
    const bad = { ok: false, status: 502, body: null, text: async () => "bad gateway" };
    const { rec, fetches } = await runRetryStream([bad, good]);
    assert.equal(fetches(), 2, "one retry expected");
    assert.deepEqual(rec.calls, [["text", "ok"], ["done"]]);
});

test("25. AUTH (401) is never retried", async () => {
    const { rec, fetches } = await runRetryStream([{ ok: false, status: 401, body: null }]);
    assert.equal(fetches(), 1, "auth failures must not retry");
    assert.deepEqual(rec.calls, [["error", "AUTH"]]);
});

test("26. no retry once content has streamed (mid-stream failure surfaces)", async () => {
    let reads = 0;
    const body = {
        getReader: () => ({
            read() {
                reads++;
                if (reads === 1) {
                    return Promise.resolve({
                        done: false,
                        value: enc.encode('event: response.text.delta\ndata: {"text":"partial"}\n\n')
                    });
                }
                return Promise.reject(new Error("connection reset"));
            }
        })
    };
    const { rec, fetches } = await runRetryStream([{ body }]);
    assert.equal(fetches(), 1, "delivered content must block retries");
    assert.deepEqual(rec.calls, [["text", "partial"], ["error", "connection reset"]]);
});

test("27. retries exhausted -> final transient error surfaces once", async () => {
    const bad = { ok: false, status: 503, body: null, text: async () => "unavailable" };
    const { rec, fetches } = await runRetryStream([bad], { maxRetries: 1 });
    assert.equal(fetches(), 2, "initial attempt + 1 retry");
    assert.equal(rec.of("error").length, 1, "exactly one error must surface");
    assert.ok(rec.of("error")[0][1].includes("503"));
});

// --- AgentConnection: auth modes + conversation id header ------------------

test("28. shared-key mode sends x-proxy-key + x-conversation-id, no Authorization", async () => {
    const rec = await runStream({ body: streamFromChunks([HAPPY_SSE]) });
    assert.equal(rec.fetchCalls.length, 1);
    const { url, init } = rec.fetchCalls[0];
    assert.equal(url, "https://proxy.example/agent");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-proxy-key"], "key123");
    assert.equal(init.headers["x-conversation-id"], "conv-abc123");
    assert.equal("Authorization" in init.headers, false, "no Authorization header in key mode");
    assert.deepEqual(JSON.parse(init.body), { messages: MESSAGES });
});

test("29. bearer mode sends Authorization: Bearer and NO x-proxy-key", async () => {
    const rec = await runStream(
        { body: streamFromChunks([HAPPY_SSE]) },
        { authMode: "bearer", credential: "tok-42" });
    const { init } = rec.fetchCalls[0];
    assert.equal(init.headers["Authorization"], "Bearer tok-42");
    assert.equal("x-proxy-key" in init.headers, false, "no x-proxy-key header in bearer mode");
    assert.equal(init.headers["x-conversation-id"], "conv-abc123");
    // stream still parses identically in bearer mode
    assert.deepEqual(rec.calls, HAPPY_EXPECTED);
});

test("30. missing conversationId -> header omitted entirely", async () => {
    const rec = await runStream(
        { body: streamFromChunks([HAPPY_SSE]) },
        { conversationId: undefined });
    const { init } = rec.fetchCalls[0];
    assert.equal("x-conversation-id" in init.headers, false);
});

test("31. findVegaSpec strips usermeta so a spec can't override embed options (ast:true)", () => {
    const spec = {
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        mark: "bar", encoding: { x: { field: "a" } },
        usermeta: { embedOptions: { ast: false } }
    };
    const out = findVegaSpec(spec);
    assert.ok(out, "spec is still recognized");
    assert.equal("usermeta" in out, false, "usermeta must be stripped");
    assert.equal(out.mark, "bar", "the rest of the spec survives");
    assert.equal("usermeta" in spec, true, "the caller's object is not mutated");

    // nested + JSON-encoded paths strip too (the restore path replays stored specs)
    const nested = findVegaSpec({ chart_spec: JSON.stringify(spec) });
    assert.ok(nested && !("usermeta" in nested));
});

test("32. agent profile rides as x-agent-profile only when set", async () => {
    const withProfile = await runStream(
        { body: streamFromChunks([HAPPY_SSE]) },
        { agentProfile: "spartan-trends" });
    assert.equal(withProfile.fetchCalls[0].init.headers["x-agent-profile"], "spartan-trends");

    const without = await runStream({ body: streamFromChunks([HAPPY_SSE]) });
    assert.equal("x-agent-profile" in without.fetchCalls[0].init.headers, false,
        "blank/unset profile sends no header (middleware default agent)");
});

test("33. AGENT_PROFILE_RX blocks values that would throw inside fetch header serialization", async () => {
    const { AGENT_PROFILE_RX } = await import("./build/agentClient.js");
    for (const ok of ["spartan-trends", "A1", "x_y-2", "a".repeat(64)]) {
        assert.ok(AGENT_PROFILE_RX.test(ok), `${ok} must pass`);
    }
    for (const bad of ["spartan–trends", "-lead", "", "ü", "a b", "a".repeat(65), "名前"]) {
        assert.equal(AGENT_PROFILE_RX.test(bad), false, `${JSON.stringify(bad)} must fail`);
    }
});
