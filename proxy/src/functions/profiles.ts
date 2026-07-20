/**
 * Named agent profiles: one deployed proxy fronts any number of Cortex agents,
 * so the visual is built once and never rebuilt for agent changes (see
 * ARCHITECTURE.md, "Agent selection at scale").
 *
 * Config surface (app settings):
 *   AGENT_DATABASE / AGENT_SCHEMA / AGENT_NAME / SNOWFLAKE_PAT — the DEFAULT
 *     agent, used when the caller sends no profile. Unchanged from before.
 *   AGENT_PROFILES — optional JSON map of profile name → target, e.g.
 *     {"spartan-trends": {"database":"DBS_ANALYTICS_AI","schema":"SPARTAN_TRENDS_AI",
 *      "agent":"SPARTAN_TRENDS_CA","patSetting":"SNOWFLAKE_PAT_SPARTAN"}}
 *     `patSetting` (optional) NAMES another app setting holding that profile's
 *     credential — secrets never live inside the JSON itself. Omitted ⇒ the
 *     shared SNOWFLAKE_PAT is used (same role for that profile).
 *
 * The caller selects a profile with the `x-agent-profile` request header
 * (set from the visual's Format-pane "Agent profile" field). Everything is
 * fail-closed: unknown names, bad characters, malformed JSON, or a missing
 * per-profile credential all reject the request — no fallback to the default
 * agent on a *requested-but-broken* profile, so a typo can't silently answer
 * from the wrong agent.
 *
 * SECURITY — profiles are agent ROUTING, not authorization. Every credential
 * registered in AGENT_PROFILES is reachable by EVERY authenticated caller of
 * this proxy (the shared key / any valid tenant token gates the proxy, not
 * individual profiles). Register only agents and roles you are willing to
 * expose to all users of this deployment; if two audiences need different
 * privileges under Model A, run two proxies with two keys. Per-user
 * authorization is Model B's per-user OBO flow (see ARCHITECTURE.md).
 *
 * All identifiers are validated before being interpolated into the upstream
 * URL — that is the injection barrier.
 */

/**
 * URL-path-safe name token. Deliberately looser than Snowflake's unquoted
 * identifier rule (quoted names like MY-AGENT are legal in the REST path) but
 * hard on anything URL-structural: no slash, colon, dot, percent, query or
 * space characters — so no path traversal (URL parsers normalize dot
 * segments), no query/fragment injection, no percent-decoding surprises.
 */
const IDENT = /^[A-Za-z0-9_$-]{1,255}$/;
/** Profile names: short, header-safe. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AgentTarget {
    ok: true;
    profile: string; // "default" or the requested name — for log lines
    database: string;
    schema: string;
    agent: string;
    pat: string;
}
export type TargetOutcome =
    | AgentTarget
    | { ok: false; status: number; clientError: string; logReason: string };

const badProfile = (logReason: string): TargetOutcome => ({
    ok: false, status: 400,
    clientError: "unknown or misconfigured agent profile", // generic on purpose — detail goes to logs only
    logReason
});

export function resolveAgentTarget(
    profileHeader: string | null | undefined,
    getEnv: (k: string) => string
): TargetOutcome {
    const requested = (profileHeader ?? "").trim();

    if (!requested) {
        // Default agent from the classic app settings.
        const database = getEnv("AGENT_DATABASE"), schema = getEnv("AGENT_SCHEMA"), agent = getEnv("AGENT_NAME");
        if (![database, schema, agent].every(v => IDENT.test(v))) {
            return { ok: false, status: 500, clientError: "middleware not configured",
                logReason: "default AGENT_DATABASE/AGENT_SCHEMA/AGENT_NAME unset or not valid identifiers" };
        }
        const pat = getEnv("SNOWFLAKE_PAT");
        if (!pat) {
            return { ok: false, status: 500, clientError: "middleware not configured",
                logReason: "SNOWFLAKE_PAT unset" };
        }
        return { ok: true, profile: "default", database, schema, agent, pat };
    }

    if (!PROFILE_NAME.test(requested)) return badProfile("profile name fails charset check");
    const raw = getEnv("AGENT_PROFILES");
    if (!raw) return badProfile(`profile "${requested}" requested but AGENT_PROFILES is unset`);

    let profiles: unknown;
    try { profiles = JSON.parse(raw); } catch {
        return badProfile("AGENT_PROFILES is not valid JSON");
    }
    const entry = profiles && typeof profiles === "object" && !Array.isArray(profiles)
        ? (profiles as Record<string, unknown>)[requested]
        : undefined;
    if (!entry || typeof entry !== "object") return badProfile(`no profile named "${requested}"`);

    const p = entry as Record<string, unknown>;
    const database = String(p.database ?? ""), schema = String(p.schema ?? ""), agent = String(p.agent ?? "");
    if (![database, schema, agent].every(v => IDENT.test(v))) {
        return badProfile(`profile "${requested}" has missing/invalid identifiers`);
    }
    const patSetting = p.patSetting === undefined ? "SNOWFLAKE_PAT" : String(p.patSetting);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(patSetting)) {
        return badProfile(`profile "${requested}" has an invalid patSetting name`);
    }
    const pat = getEnv(patSetting);
    if (!pat) return badProfile(`profile "${requested}": credential setting ${patSetting} is unset/empty`);

    return { ok: true, profile: requested, database, schema, agent, pat };
}
