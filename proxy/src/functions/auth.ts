/**
 * Pluggable caller authentication for the agent proxy (see ARCHITECTURE.md,
 * "Authentication" ladder). Selected by the AUTH_MODE app setting:
 *
 *   "shared-key" (default when unset) — the visual presents `x-proxy-key`;
 *       constant-time compare against PROXY_API_KEY; fails closed (401) when
 *       the configured key is empty/unset.
 *   "entra" — the visual presents `Authorization: Bearer <JWT>`; the token is
 *       validated offline: signature against the tenant's JWKS
 *       (https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys),
 *       issuer (v2 form, plus the legacy v1 sts.windows.net form), audience
 *       === ENTRA_AUDIENCE, and expiry. Fails closed (401) when
 *       ENTRA_TENANT_ID or ENTRA_AUDIENCE is unset.
 *
 * Everything here is fail-closed: no recognizable, fully-configured auth mode
 * means no request gets through.
 *
 * Deliberately free of @azure/functions imports so the module compiles and
 * runs standalone in unit tests (tests/unit-proxyauth.mjs); the JWKS resolver
 * is injectable so token validation is testable without any network.
 */
import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

/** The read surface we need from fetch `Headers` / Azure's `HttpRequest.headers`. */
export interface HeaderReader {
    get(name: string): string | null;
}

/** Raw app-setting values; `authenticate` interprets them (empty ⇒ unset). */
export interface AuthSettings {
    mode?: string;      // AUTH_MODE: "" | "shared-key" | "entra"
    sharedKey?: string; // PROXY_API_KEY
    tenantId?: string;  // ENTRA_TENANT_ID (directory/tenant GUID)
    audience?: string;  // ENTRA_AUDIENCE (expected `aud` claim, exact match)
    jwksUrl?: string;   // ENTRA_JWKS_URL — E2E-test hook only; leave unset in production
}

export type AuthOutcome =
    | { ok: true }
    /** clientError is safe for the 401 body; logReason is server-log detail. */
    | { ok: false; clientError: string; logReason: string };

/** Constant-time string comparison (length leak only). */
export function keysMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** shared-key mode. Fail-closed check on the configured key comes FIRST. */
export function checkSharedKey(presented: string | null, expected: string | undefined): AuthOutcome {
    if (!expected || !keysMatch(presented ?? "", expected)) {
        return {
            ok: false,
            clientError: "bad or missing x-proxy-key",
            logReason: expected ? "x-proxy-key missing or mismatched"
                                : "PROXY_API_KEY unset/empty — failing closed"
        };
    }
    return { ok: true };
}

/** Issuer forms Entra stamps into tokens for one tenant (v2, and legacy v1). */
export function issuersFor(tenantId: string): string[] {
    return [
        `https://login.microsoftonline.com/${tenantId}/v2.0`,
        `https://sts.windows.net/${tenantId}/`
    ];
}

/**
 * One cached remote-JWKS resolver per URL, shared across invocations of this
 * Function instance. jose handles the cache: keys are reused for up to
 * cacheMaxAge (~1h), and an unknown `kid` triggers a single refetch (further
 * refetches are suppressed for cooldownDuration, so key rollovers are picked
 * up once without letting bad tokens hammer the JWKS endpoint).
 */
const jwksResolvers = new Map<string, JWTVerifyGetKey>();
function remoteJwks(url: string): JWTVerifyGetKey {
    let resolver = jwksResolvers.get(url);
    if (!resolver) {
        resolver = createRemoteJWKSet(new URL(url), {
            cacheMaxAge: 60 * 60 * 1000, // ~1h TTL
            cooldownDuration: 30 * 1000  // unknown kid ⇒ at most one refetch per 30s
        });
        jwksResolvers.set(url, resolver);
    }
    return resolver;
}

/**
 * entra mode: validate `Authorization: Bearer <JWT>`.
 * `getKey` overrides the JWKS resolver (unit tests inject a local key set).
 */
export async function checkEntraBearer(
    authorization: string | null,
    settings: AuthSettings,
    getKey?: JWTVerifyGetKey
): Promise<AuthOutcome> {
    const clientError = "bad or missing bearer token"; // generic on purpose — detail goes to logs only
    if (!settings.tenantId || !settings.audience) {
        return { ok: false, clientError, logReason: "ENTRA_TENANT_ID/ENTRA_AUDIENCE unset — failing closed" };
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    if (!match) {
        return { ok: false, clientError, logReason: "missing or malformed Authorization header" };
    }
    const jwksUrl = settings.jwksUrl ||
        `https://login.microsoftonline.com/${settings.tenantId}/discovery/v2.0/keys`;
    try {
        // jwtVerify checks signature, exp/nbf, issuer and audience in one shot.
        await jwtVerify(match[1], getKey ?? remoteJwks(jwksUrl), {
            issuer: issuersFor(settings.tenantId),
            audience: settings.audience,
            algorithms: ["RS256"] // Entra signs access tokens with RS256
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, clientError, logReason: `token rejected: ${e instanceof Error ? e.message : String(e)}` };
    }
}

/** Mode dispatch. Unknown AUTH_MODE values fail closed rather than guessing. */
export async function authenticate(
    headers: HeaderReader,
    settings: AuthSettings,
    getKey?: JWTVerifyGetKey
): Promise<AuthOutcome> {
    const mode = (settings.mode ?? "").trim() || "shared-key";
    switch (mode) {
        case "shared-key":
            return checkSharedKey(headers.get("x-proxy-key"), settings.sharedKey);
        case "entra":
            return checkEntraBearer(headers.get("authorization"), settings, getKey);
        default:
            return {
                ok: false,
                clientError: "auth not configured",
                logReason: `unknown AUTH_MODE ${JSON.stringify(mode)} — failing closed`
            };
    }
}

/**
 * `x-conversation-id` is a log-correlation aid only (see ARCHITECTURE.md,
 * "Session management"): strip to [A-Za-z0-9_-], cap at 64 chars, and never
 * trust or forward it to Snowflake.
 */
export function sanitizeConversationId(raw: string | null | undefined): string {
    return (raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}
