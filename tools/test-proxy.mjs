/**
 * End-to-end tests for the compiled Azure Function SSE relay (proxy/dist)
 * against the local mock Snowflake server (tools/mock-snowflake.mjs, :8043).
 *
 * No frameworks — node:assert only. Run via tools/run-e2e.sh.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
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
    for (const h of ["x-proxy-key", "authorization", "x-conversation-id"]) {
        assert.ok(res.headers["Access-Control-Allow-Headers"].includes(h),
            `Allow-Headers must list ${h}`);
    }
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

// (g) x-conversation-id: sanitized value appears in log lines, raw value never does
await test("g. x-conversation-id sanitized into log lines, never raw", async () => {
    const lines = [];
    const push = (...a) => lines.push(a.map(String).join(" "));
    const capturingCtx = { log: push, warn: push, error: push };
    const res = await agentHandler(makeReq({
        headers: { origin: ORIGIN, "x-proxy-key": "k123", "x-conversation-id": "conv-42!!<script>" },
        body: GOOD_BODY
    }), capturingCtx);
    assert.equal(res.status, 200);
    for await (const _ of res.body) { /* drain the relay */ }
    assert.ok(lines.some(l => l.includes("conv-42script")),
        `sanitized conversation id missing from logs: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some(l => l.includes("<script>")), "raw header value must never be logged");
});

// (h) AUTH_MODE=entra end-to-end: bearer JWT validated against a local JWKS, then relayed
await test("h. AUTH_MODE=entra -> bearer accepted, shared key/wrong aud rejected", async () => {
    // Local signing key + JWKS endpoint standing in for login.microsoftonline.com.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const KID = "e2e-kid";
    const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" }] });
    const jwksSrv = http.createServer((_q, s) => { s.setHeader("content-type", "application/json"); s.end(jwks); });
    await new Promise(r => jwksSrv.listen(8044, "127.0.0.1", r));

    const b64u = (s) => Buffer.from(s).toString("base64url");
    const signJwt = (payload) => {
        const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID }));
        const body = b64u(JSON.stringify(payload));
        return `${head}.${body}.${b64u(cryptoSign("sha256", Buffer.from(`${head}.${body}`), privateKey))}`;
    };
    const TENANT = "e2e-tenant";
    const now = Math.floor(Date.now() / 1000);
    process.env.AUTH_MODE = "entra";
    process.env.ENTRA_TENANT_ID = TENANT;
    process.env.ENTRA_AUDIENCE = "api://e2e-proxy";
    process.env.ENTRA_JWKS_URL = "http://127.0.0.1:8044/keys"; // test hook in auth.ts
    try {
        // shared key is no longer a way in
        const viaKey = await agentHandler(
            makeReq({ headers: { origin: ORIGIN, "x-proxy-key": "k123" }, body: GOOD_BODY }), ctx);
        assert.equal(viaKey.status, 401, "x-proxy-key must not authenticate in entra mode");

        // wrong audience rejected
        const badAud = signJwt({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
            aud: "api://someone-else", iat: now - 30, exp: now + 300 });
        const viaBadAud = await agentHandler(
            makeReq({ headers: { origin: ORIGIN, authorization: `Bearer ${badAud}` }, body: GOOD_BODY }), ctx);
        assert.equal(viaBadAud.status, 401, "wrong audience must be rejected");

        // valid bearer token streams straight through
        const good = signJwt({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
            aud: "api://e2e-proxy", iat: now - 30, exp: now + 300 });
        const res = await agentHandler(
            makeReq({ headers: { origin: ORIGIN, authorization: `Bearer ${good}` }, body: GOOD_BODY }), ctx);
        assert.equal(res.status, 200, "valid bearer token must pass");
        assert.equal(res.headers["Content-Type"], "text/event-stream");
        const dec = new TextDecoder();
        let text = "";
        for await (const chunk of res.body) text += dec.decode(chunk, { stream: true });
        text += dec.decode();
        assert.ok(text.includes("event: response.text.delta"), "SSE relay must still stream in entra mode");
    } finally {
        process.env.AUTH_MODE = "shared-key";
        delete process.env.ENTRA_TENANT_ID;
        delete process.env.ENTRA_AUDIENCE;
        delete process.env.ENTRA_JWKS_URL;
        await new Promise(r => jwksSrv.close(r));
    }
});

await test("i. sandboxed-visual Origin 'null' -> wildcard CORS by default; allowlist mode stays strict", async () => {
    // Power BI visuals live in a sandboxed iframe (opaque origin): the browser sends
    // the literal string "null" as Origin. With ALLOWED_ORIGINS unset the proxy must
    // answer "*" so the visual works from Service, Desktop (null or absent), anywhere.
    delete process.env.ALLOWED_ORIGINS;
    try {
        const pre = await agentHandler(makeReq({ method: "OPTIONS", headers: { origin: "null" } }), ctx);
        assert.equal(pre.status, 204);
        assert.equal(pre.headers["Access-Control-Allow-Origin"], "*", "default must be wildcard for Origin: null");
        assert.equal("Access-Control-Allow-Credentials" in pre.headers, false, "wildcard is only safe credential-less");

        const noOrigin = await agentHandler(makeReq({ method: "OPTIONS", headers: {} }), ctx);
        assert.equal(noOrigin.headers["Access-Control-Allow-Origin"], "*", "absent Origin (Desktop) must also get *");

        const res = await agentHandler(
            makeReq({ headers: { origin: "null", "x-proxy-key": "k123" }, body: GOOD_BODY }), ctx);
        assert.equal(res.status, 200, "null-origin caller with a valid key must stream");
        assert.equal(res.headers["Access-Control-Allow-Origin"], "*");

        // Tightened deployments keep strict allowlist semantics: no null echo, no wildcard.
        process.env.ALLOWED_ORIGINS = "https://example.com";
        const strict = await agentHandler(makeReq({ method: "OPTIONS", headers: { origin: "null" } }), ctx);
        assert.equal(strict.headers["Access-Control-Allow-Origin"], "https://example.com",
            "allowlist mode must NOT echo null (browser blocks the unlisted caller)");
    } finally {
        process.env.ALLOWED_ORIGINS = "https://app.powerbi.com"; // restore for any later checks
    }
});

if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
}
console.log("\nAll tests passed");
