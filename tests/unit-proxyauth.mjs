/**
 * Unit tests for proxy/src/functions/auth.ts — pluggable proxy auth
 * (AUTH_MODE: shared-key | entra) + conversation-id sanitization.
 *
 * Compile first with: proxy/node_modules/.bin/tsc -p tests/tsconfig.proxy.json
 * (or just run tests/run-tests.sh — it also links `jose` into
 * tests/node_modules so the compiled ESM module can resolve it).
 *
 * Entra tokens are signed locally with a generated RSA key; a local "JWKS"
 * resolver (kid lookup → public KeyObject) is injected in place of the remote
 * Microsoft JWKS, so nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
    authenticate, checkSharedKey, checkEntraBearer,
    keysMatch, issuersFor, sanitizeConversationId
} from "./build-proxy/functions/auth.js";

// ---------------------------------------------------------------- helpers ---

const H = (obj = {}) => new Headers(obj); // case-insensitive .get(), like HttpRequest.headers

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "unit-test-kid";

/** Local JWKS stand-in: resolve the signing key by kid, like the remote set would. */
const localJwks = (protectedHeader) => {
    if (protectedHeader.kid !== KID) throw new Error(`kid ${protectedHeader.kid} not in local JWKS`);
    return publicKey;
};

const b64u = (s) => Buffer.from(s).toString("base64url");

/** Minimal RS256 JWT signer (node:crypto only — RSASSA-PKCS1-v1_5 + SHA-256). */
function makeJwt(payload, { kid = KID, alg = "RS256", key = privateKey } = {}) {
    const head = b64u(JSON.stringify({ alg, typ: "JWT", kid }));
    const body = b64u(JSON.stringify(payload));
    const sig = cryptoSign("sha256", Buffer.from(`${head}.${body}`), key);
    return `${head}.${body}.${b64u(sig)}`;
}

const TENANT = "11111111-2222-3333-4444-555555555555";
const AUD = "api://cortex-proxy-test";
const now = () => Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: AUD,
    sub: "someone@example.com",
    iat: now() - 60, nbf: now() - 60, exp: now() + 3600,
    ...over
});
const ENTRA = { mode: "entra", tenantId: TENANT, audience: AUD };

// ------------------------------------------------------- shared-key mode ---

test("1. shared-key: correct key passes (default mode when AUTH_MODE unset/empty)", async () => {
    for (const mode of [undefined, "", "shared-key", "  shared-key  "]) {
        const r = await authenticate(H({ "x-proxy-key": "k123" }), { mode, sharedKey: "k123" });
        assert.equal(r.ok, true, `mode=${JSON.stringify(mode)} should pass`);
    }
});

test("2. shared-key: wrong or missing key -> not ok, same client error as before", async () => {
    const wrong = await authenticate(H({ "x-proxy-key": "nope" }), { sharedKey: "k123" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.clientError, "bad or missing x-proxy-key");
    const missing = await authenticate(H(), { sharedKey: "k123" });
    assert.equal(missing.ok, false);
});

test("3. shared-key: empty/unset configured key fails closed (even for empty presented key)", async () => {
    for (const sharedKey of ["", undefined]) {
        const r = await authenticate(H({ "x-proxy-key": "" }), { mode: "shared-key", sharedKey });
        assert.equal(r.ok, false, "must fail closed when PROXY_API_KEY is unset/empty");
    }
    assert.equal(checkSharedKey(null, "").ok, false);
    assert.equal(checkSharedKey("anything", undefined).ok, false);
});

test("4. shared-key: constant-time compare path still used", () => {
    // Behavior: mismatched lengths and mismatched bytes both fail, equality passes.
    assert.equal(keysMatch("k123", "k123"), true);
    assert.equal(keysMatch("k123", "k1234"), false);
    assert.equal(keysMatch("k123", "k124"), false);
    // Guard against a silent swap to `===`: the compiled module must still go
    // through node:crypto's timingSafeEqual.
    const src = readFileSync(new URL("./build-proxy/functions/auth.js", import.meta.url), "utf8");
    assert.match(src, /timingSafeEqual/);
});

test("5. unknown AUTH_MODE fails closed", async () => {
    const r = await authenticate(H({ "x-proxy-key": "k123", authorization: `Bearer ${makeJwt(claims())}` }),
        { mode: "none", sharedKey: "k123", tenantId: TENANT, audience: AUD }, localJwks);
    assert.equal(r.ok, false);
});

// ------------------------------------------------------------ entra mode ---

test("6. entra: missing ENTRA_TENANT_ID / ENTRA_AUDIENCE fails closed (even with a valid token)", async () => {
    const token = `Bearer ${makeJwt(claims())}`;
    for (const settings of [
        { mode: "entra" },
        { mode: "entra", tenantId: TENANT },            // audience unset
        { mode: "entra", audience: AUD },               // tenant unset
        { mode: "entra", tenantId: "", audience: "" }
    ]) {
        const r = await authenticate(H({ authorization: token }), settings, localJwks);
        assert.equal(r.ok, false, `settings=${JSON.stringify(settings)} must fail closed`);
    }
});

test("7. entra: valid token passes (v2 issuer)", async () => {
    const r = await authenticate(H({ authorization: `Bearer ${makeJwt(claims())}` }), ENTRA, localJwks);
    assert.equal(r.ok, true, JSON.stringify(r));
});

test("8. entra: legacy v1 issuer form (sts.windows.net) also accepted", async () => {
    const token = makeJwt(claims({ iss: `https://sts.windows.net/${TENANT}/` }));
    const r = await authenticate(H({ authorization: `Bearer ${token}` }), ENTRA, localJwks);
    assert.equal(r.ok, true, JSON.stringify(r));
    // sanity on the exported issuer list itself
    assert.deepEqual(issuersFor("t"), [
        "https://login.microsoftonline.com/t/v2.0",
        "https://sts.windows.net/t/"
    ]);
});

test("9. entra: wrong audience rejected", async () => {
    const token = makeJwt(claims({ aud: "api://someone-else" }));
    const r = await authenticate(H({ authorization: `Bearer ${token}` }), ENTRA, localJwks);
    assert.equal(r.ok, false);
    assert.equal(r.clientError, "bad or missing bearer token");
});

test("10. entra: wrong issuer (other tenant) rejected", async () => {
    const token = makeJwt(claims({ iss: "https://login.microsoftonline.com/99999999-aaaa-bbbb-cccc-dddddddddddd/v2.0" }));
    const r = await authenticate(H({ authorization: `Bearer ${token}` }), ENTRA, localJwks);
    assert.equal(r.ok, false);
});

test("11. entra: expired token rejected", async () => {
    const token = makeJwt(claims({ exp: now() - 10 }));
    const r = await authenticate(H({ authorization: `Bearer ${token}` }), ENTRA, localJwks);
    assert.equal(r.ok, false);
});

test("12. entra: absent/malformed Authorization header rejected", async () => {
    for (const headers of [
        H(),                                              // absent
        H({ authorization: "Bearer" }),                   // no token
        H({ authorization: "Bearer  " }),                 // whitespace token
        H({ authorization: `Basic ${makeJwt(claims())}` }),  // wrong scheme
        H({ authorization: makeJwt(claims()) }),          // bare token, no scheme
        H({ authorization: "Bearer not.a.jwt" })          // garbage token
    ]) {
        const r = await authenticate(headers, ENTRA, localJwks);
        assert.equal(r.ok, false, `should reject ${JSON.stringify(headers.get("authorization"))}`);
    }
});

test("13. entra: tampered signature and unknown kid rejected", async () => {
    const token = makeJwt(claims());
    const [h, p, s] = token.split(".");
    const flipped = s.slice(0, -2) + (s.at(-1) === "A" ? "BB" : "AA");
    const tampered = await checkEntraBearer(`Bearer ${h}.${p}.${flipped}`, ENTRA, localJwks);
    assert.equal(tampered.ok, false);

    const unknownKid = makeJwt(claims(), { kid: "rotated-away" });
    const r = await checkEntraBearer(`Bearer ${unknownKid}`, ENTRA, localJwks);
    assert.equal(r.ok, false);
});

// ----------------------------------------------------- conversation id ---

test("14. conversation-id sanitization: strip to [A-Za-z0-9_-], cap 64, empty-safe", () => {
    assert.equal(sanitizeConversationId("conv_ABC-123"), "conv_ABC-123");     // untouched
    assert.equal(sanitizeConversationId("conv 42!!<script>/x\n"), "conv42scriptx");
    assert.equal(sanitizeConversationId("a b\tc\nd"), "abcd");
    assert.equal(sanitizeConversationId("<img src=x onerror=1>"), "imgsrcxonerror1");
    assert.equal(sanitizeConversationId("x".repeat(200)).length, 64);
    assert.equal(sanitizeConversationId(""), "");
    assert.equal(sanitizeConversationId(null), "");
    assert.equal(sanitizeConversationId(undefined), "");
});
