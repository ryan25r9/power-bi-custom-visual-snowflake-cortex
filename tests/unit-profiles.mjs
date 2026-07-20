/**
 * Unit tests for proxy/src/functions/profiles.ts — named agent profiles.
 * The security property under test: every path that could change WHICH agent
 * a request reaches is fail-closed and injection-proof (identifiers validated
 * before they are interpolated into the upstream URL).
 *
 * Compiled by tests/tsconfig.proxy.json (run via tests/run-tests.sh).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentTarget } from "./build-proxy/functions/profiles.js";

/** getEnv stub over a plain object; missing keys read as "". */
const envOf = (o) => (k) => o[k] ?? "";

const DEFAULT_ENV = {
    AGENT_DATABASE: "AI_DB", AGENT_SCHEMA: "AGENTS", AGENT_NAME: "REPORT_CHAT_AGENT",
    SNOWFLAKE_PAT: "pat-default"
};
const PROFILES = JSON.stringify({
    "spartan-trends": { database: "DBS_ANALYTICS_AI", schema: "SPARTAN_TRENDS_AI", agent: "SPARTAN_TRENDS_CA" },
    "dining": { database: "DBS_ANALYTICS_AI", schema: "DINING_AI", agent: "DINING_CA", patSetting: "SNOWFLAKE_PAT_DINING" },
    "broken": { database: "bad name!", schema: "S", agent: "A" }
});

test("1. no header -> default agent from classic settings", () => {
    for (const header of [null, undefined, "", "   "]) {
        const t = resolveAgentTarget(header, envOf(DEFAULT_ENV));
        assert.equal(t.ok, true);
        assert.equal(t.profile, "default");
        assert.deepEqual([t.database, t.schema, t.agent, t.pat],
            ["AI_DB", "AGENTS", "REPORT_CHAT_AGENT", "pat-default"]);
    }
});

test("2. default agent misconfigured -> 500, never a garbage URL", () => {
    const bad = resolveAgentTarget(null, envOf({ ...DEFAULT_ENV, AGENT_NAME: "" }));
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 500);
    const noPat = resolveAgentTarget(null, envOf({ ...DEFAULT_ENV, SNOWFLAKE_PAT: "" }));
    assert.equal(noPat.ok, false);
    assert.equal(noPat.status, 500);
});

test("3. named profile resolves; shared PAT by default", () => {
    const t = resolveAgentTarget("spartan-trends", envOf({ ...DEFAULT_ENV, AGENT_PROFILES: PROFILES }));
    assert.equal(t.ok, true);
    assert.deepEqual([t.profile, t.database, t.schema, t.agent, t.pat],
        ["spartan-trends", "DBS_ANALYTICS_AI", "SPARTAN_TRENDS_AI", "SPARTAN_TRENDS_CA", "pat-default"]);
});

test("4. patSetting indirection: per-profile credential, fail-closed when unset", () => {
    const env = { ...DEFAULT_ENV, AGENT_PROFILES: PROFILES, SNOWFLAKE_PAT_DINING: "pat-dining" };
    const t = resolveAgentTarget("dining", envOf(env));
    assert.equal(t.ok, true);
    assert.equal(t.pat, "pat-dining", "profile uses ITS credential, not the shared one");

    const missing = resolveAgentTarget("dining", envOf({ ...DEFAULT_ENV, AGENT_PROFILES: PROFILES }));
    assert.equal(missing.ok, false, "unset per-profile credential must not fall back silently");
    assert.equal(missing.status, 400);
});

test("5. unknown profile / unset AGENT_PROFILES / malformed JSON all fail closed with a generic error", () => {
    const withProfiles = envOf({ ...DEFAULT_ENV, AGENT_PROFILES: PROFILES });
    for (const [header, env] of [
        ["nope", withProfiles],
        ["spartan-trends", envOf(DEFAULT_ENV)],                                  // profiles unset
        ["spartan-trends", envOf({ ...DEFAULT_ENV, AGENT_PROFILES: "{oops" })],  // malformed JSON
        ["broken", withProfiles]                                                 // bad identifiers inside
    ]) {
        const t = resolveAgentTarget(header, env);
        assert.equal(t.ok, false, `must reject: ${header}`);
        assert.equal(t.status, 400);
        assert.equal(t.clientError, "unknown or misconfigured agent profile",
            "client error stays generic — no profile-name oracle");
    }
});

test("6. injection attempts in the profile name never reach URL building", () => {
    const env = envOf({ ...DEFAULT_ENV, AGENT_PROFILES: PROFILES });
    for (const evil of ["../etc", "a/b", "a b", "a:run", "a?x=1", "%2e%2e", "a\nb", "-lead", "x".repeat(65)]) {
        const t = resolveAgentTarget(evil, env);
        assert.equal(t.ok, false, `charset gate must reject ${JSON.stringify(evil)}`);
        assert.equal(t.status, 400);
    }
});

test("7. identifier gate on profile contents (defense against a poisoned AGENT_PROFILES value)", () => {
    const sneaky = JSON.stringify({
        p: { database: "DB/../..", schema: "S", agent: "A" },   // slash → path traversal
        q: { database: "DB", schema: "S", agent: "A:run?x=" },  // colon/query chars
        d: { database: "DB", schema: "S", agent: "A.B" },       // dot → URL dot-segment games
        e: { database: "DB", schema: "S", agent: "A%2F" },      // percent → encoded traversal
        r: { database: "DB", schema: "S", agent: "OK_AGENT$1" },
        h: { database: "DB", schema: "S", agent: "MY-AGENT" }   // quoted-identifier names are fine
    });
    const env = envOf({ ...DEFAULT_ENV, AGENT_PROFILES: sneaky });
    for (const bad of ["p", "q", "d", "e"]) assert.equal(resolveAgentTarget(bad, env).ok, false, bad);
    assert.equal(resolveAgentTarget("r", env).ok, true, "$ and digits are URL-safe");
    assert.equal(resolveAgentTarget("h", env).ok, true, "dashes are URL-safe (quoted Snowflake names)");
});
