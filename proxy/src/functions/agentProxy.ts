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
 *  PROXY_API_KEY          shared key the visual must present (rotate freely)
 *  ALLOWED_ORIGINS        comma-separated; default https://app.powerbi.com
 *
 * Production upgrade path (see README §7): replace PROXY_API_KEY with Entra ID
 * JWT validation and swap SNOWFLAKE_PAT for per-user External OAuth tokens.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { timingSafeEqual } from "node:crypto";

app.setup({ enableHttpStream: true }); // required to relay SSE

const env = (k: string, fallback = ""): string => process.env[k] ?? fallback;

/** Constant-time string comparison (length leak only). */
function keysMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function corsHeaders(req: HttpRequest): Record<string, string> {
    const allowed = env("ALLOWED_ORIGINS", "https://app.powerbi.com").split(",").map(s => s.trim());
    const origin = req.headers.get("origin") ?? "";
    // Power BI Desktop sends no/null Origin; the Service sends https://app.powerbi.com.
    // The "*" branch only fires for origin-less clients (Desktop/curl) and we never use
    // Allow-Credentials, so it grants nothing a non-browser client doesn't already have.
    // Browser callers from unlisted origins get allowed[0], which won't match -> blocked.
    const allow = allowed.includes(origin) ? origin : (origin ? allowed[0] : "*");
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-proxy-key",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
    };
}

export async function agentHandler(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return { status: 204, headers: cors };

    // --- auth (POC: shared key; PROD: validate an Entra ID bearer JWT here) ---
    // Fail-closed check on the configured key MUST come first; comparison is constant-time.
    const expectedKey = env("PROXY_API_KEY");
    if (!expectedKey || !keysMatch(req.headers.get("x-proxy-key") ?? "", expectedKey)) {
        return { status: 401, headers: cors, jsonBody: { error: "bad or missing x-proxy-key" } };
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

    let upstream: Response;
    try {
        upstream = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "Authorization": `Bearer ${env("SNOWFLAKE_PAT")}`
            },
            body: JSON.stringify({ messages: body.messages })
        });
    } catch (e) {
        ctx.error("Snowflake unreachable", e);
        return { status: 502, headers: cors, jsonBody: { error: "Snowflake unreachable" } };
    }

    if (!upstream.ok || !upstream.body) {
        // Full upstream body goes to the Function logs only — Snowflake error text can
        // reveal account/agent internals, so the client gets a generic pointer instead.
        const detail = (await upstream.text().catch(() => "")).slice(0, 500);
        ctx.error(`Snowflake ${upstream.status}: ${detail}`);
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
