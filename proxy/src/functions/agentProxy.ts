/**
 * Azure Function (Node v4 model) — thin SSE relay between the Power BI visual
 * and the Snowflake Cortex Agents `agent:run` endpoint.
 *
 * Why it exists:
 *  1. CORS — Snowflake's REST API won't answer a browser's cross-origin call.
 *  2. Secrets — the Snowflake credential lives HERE (app settings/Key Vault),
 *     never in the visual or the .pbix.
 *
 * App settings required (see local.settings.json.example):
 *  SNOWFLAKE_ACCOUNT_URL  https://<org>-<account>.snowflakecomputing.com
 *  SNOWFLAKE_PAT          programmatic access token of the service user (POC auth)
 *  AGENT_DATABASE / AGENT_SCHEMA / AGENT_NAME
 *  AUTH_MODE              "shared-key" (default) or "entra" — see auth.ts
 *  PROXY_API_KEY          shared key the visual must present (shared-key mode)
 *  ENTRA_TENANT_ID        Entra directory (tenant) GUID (entra mode)
 *  ENTRA_AUDIENCE         expected token audience, exact match (entra mode)
 *  ALLOWED_ORIGINS        comma-separated; default https://app.powerbi.com
 *
 * Production upgrade path (see ARCHITECTURE.md, "Authentication"): entra mode
 * validates per-user Entra ID JWTs; the remaining step is swapping
 * SNOWFLAKE_PAT for per-user External OAuth tokens. SETUP.md Part 2 covers
 * deployment.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authenticate, sanitizeConversationId } from "./auth";

app.setup({ enableHttpStream: true }); // required to relay SSE

const env = (k: string, fallback = ""): string => process.env[k] ?? fallback;

export function corsHeaders(req: HttpRequest): Record<string, string> {
    // Power BI hosts custom visuals in a sandboxed iframe WITHOUT allow-same-origin,
    // so the visual has an opaque origin and its CORS requests carry the literal
    // string "null" as Origin (Service: verified; Desktop: null or absent). There is
    // no real domain to allowlist, hence the "*" default. That is safe ONLY because
    // auth rides explicit fail-closed headers (auth.ts) and we never send
    // Allow-Credentials — CORS is not a security boundary for this endpoint.
    // If Microsoft ever gives visuals a real origin, tightening is a one-line
    // ALLOWED_ORIGINS change; the allowlist branch below already handles it.
    const allowed = env("ALLOWED_ORIGINS", "*").split(",").map(s => s.trim());
    const origin = req.headers.get("origin") ?? "";
    const allow = allowed.includes("*") ? "*"
        : allowed.includes(origin) ? origin
        : allowed[0]; // unlisted browser origins fail the browser's CORS check
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-proxy-key, authorization, x-conversation-id",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
    };
}

export async function agentHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return { status: 204, headers: cors };

    // Optional log-correlation id from the visual — sanitized, used in log
    // lines only, never trusted or forwarded to Snowflake.
    const convId = sanitizeConversationId(req.headers.get("x-conversation-id"));
    const tag = convId ? `[conv ${convId}] ` : "";

    // --- auth (AUTH_MODE: shared-key | entra) — fail-closed dispatch in auth.ts ---
    const auth = await authenticate(req.headers, {
        mode: env("AUTH_MODE"),
        sharedKey: env("PROXY_API_KEY"),
        tenantId: env("ENTRA_TENANT_ID"),
        audience: env("ENTRA_AUDIENCE"),
        jwksUrl: env("ENTRA_JWKS_URL") // E2E-test hook only; leave unset in production
    });
    if (!auth.ok) {
        ctx.warn(`${tag}auth rejected: ${auth.logReason}`);
        return { status: 401, headers: cors, jsonBody: { error: auth.clientError } };
    }

    // --- validate body shape minimally ---
    let body: { messages?: unknown };
    try { body = await req.json() as any; } catch {
        return { status: 400, headers: cors, jsonBody: { error: "invalid JSON" } };
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
        return { status: 400, headers: cors, jsonBody: { error: "messages[] required" } };
    }

    // --- relay to Snowflake ---
    const url = `${env("SNOWFLAKE_ACCOUNT_URL")}/api/v2/databases/${env("AGENT_DATABASE")}` +
                `/schemas/${env("AGENT_SCHEMA")}/agents/${env("AGENT_NAME")}:run`;
    ctx.log(`${tag}relaying ${body.messages.length} message(s) to agent:run`);

    let upstream: Response;
    try {
        upstream = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "Authorization": `Bearer ${env("SNOWFLAKE_PAT")}`,
                // Tells Snowflake the bearer token is a PAT. Officially optional, but
                // without it Snowflake guesses the token type and a bad guess surfaces
                // as a confusing "Invalid OAuth access token" error.
                "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN"
            },
            body: JSON.stringify({ messages: body.messages })
        });
    } catch (e) {
        ctx.error(`${tag}Snowflake unreachable`, e);
        return { status: 502, headers: cors, jsonBody: { error: "Snowflake unreachable" } };
    }

    if (!upstream.ok || !upstream.body) {
        // Full upstream body goes to the Function logs only — Snowflake error text can
        // reveal account/agent internals, so the client gets a generic pointer instead.
        const detail = (await upstream.text().catch(() => "")).slice(0, 500);
        ctx.error(`${tag}Snowflake ${upstream.status}: ${detail}`);
        return {
            status: upstream.status, headers: cors,
            jsonBody: { error: "snowflake_error", detail: `Upstream error (status ${upstream.status}). See proxy logs.` }
        };
    }

    // Pass the SSE stream straight through
    return {
        status: 200,
        headers: {
            ...cors,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        },
        body: upstream.body as any
    };
}

app.http("agent", {
    methods: ["POST", "OPTIONS"],
    authLevel: "anonymous", // we do our own auth; or set "function" and pass ?code=
    handler: agentHandler
});
