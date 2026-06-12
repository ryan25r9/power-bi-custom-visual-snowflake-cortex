/**
 * Streams a Cortex Agent response through the proxy.
 *
 * SSE events handled (per Snowflake Cortex Agents Run API docs):
 *   response.status              {"message","status"}                     progress line
 *   response.text.delta          {"content_index","text"}                 answer tokens
 *   response.thinking.delta      {"content_index","text"}                 reasoning tokens
 *   response.tool_use            {"type","name","input",...}              activity trail
 *   response.tool_result.status  {"status","message",...}                 activity trail
 *   response.tool_result         {"type","name","content":[{json}],...}   SQL + charts
 *   error                        {"message"}                              error
 * Unknown events are ignored by design (Snowflake adds types over time).
 */
export async function streamAgent(proxyUrl, proxyKey, messages, cb, signal) {
    let resp;
    try {
        resp = await fetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-proxy-key": proxyKey
            },
            body: JSON.stringify({ messages }),
            signal
        });
    }
    catch (e) {
        if (e.name === "AbortError")
            return;
        cb.onError(`Could not reach proxy. Check the Proxy URL setting and the WebAccess privilege in capabilities.json. (${e.message})`);
        return;
    }
    if (resp.status === 401 || resp.status === 403) {
        cb.onError("AUTH"); // sentinel: visual shows the key-entry UI
        return;
    }
    if (!resp.ok || !resp.body) {
        cb.onError(`Proxy error ${resp.status}: ${await safeText(resp)}`);
        return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            // SSE messages are separated by a blank line
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks)
                handleBlock(block, cb);
        }
        buffer += decoder.decode(); // flush any trailing multi-byte sequence
        if (buffer.trim())
            handleBlock(buffer, cb);
        cb.onDone();
    }
    catch (e) {
        if (e.name !== "AbortError")
            cb.onError(e.message);
    }
}
function handleBlock(block, cb) {
    let event = "";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:"))
            event = line.slice(6).trim();
        else if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length)
        return;
    const raw = dataLines.join("\n");
    if (raw === "[DONE]")
        return;
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return;
    }
    switch (event) {
        case "response.text.delta":
            if (typeof data.text === "string")
                cb.onTextDelta(data.text);
            break;
        case "response.thinking.delta":
            if (typeof data.text === "string")
                cb.onThinkingDelta(data.text);
            break;
        case "response.status":
            if (typeof data.message === "string")
                cb.onStatus(data.message);
            break;
        case "response.tool_use":
            cb.onToolUse(String(data.name ?? data.type ?? "tool"), String(data.type ?? ""));
            break;
        case "response.tool_result.status":
            if (typeof data.message === "string")
                cb.onToolStatus(data.message);
            else if (typeof data.status === "string")
                cb.onToolStatus(data.status);
            break;
        case "response.tool_result":
            extractToolResult(data, cb);
            break;
        case "error":
            cb.onError(String(data.message ?? raw));
            break;
        default:
            break; // annotations, metadata, final response… ignored in v1
    }
}
/** Pull renderable artifacts (SQL, Vega-Lite charts) out of a tool_result payload. */
function extractToolResult(data, cb) {
    const items = Array.isArray(data?.content) ? data.content : [];
    for (const item of items) {
        if (item?.type !== "json" || item.json == null)
            continue;
        const j = item.json;
        const sql = j.sql ?? j.query ?? j.generated_sql;
        if (typeof sql === "string" && sql.trim())
            cb.onSql(sql.trim());
        const spec = findVegaSpec(j);
        if (spec)
            cb.onChart(spec);
    }
}
/** Recognize a Vega-Lite spec directly, nested one level, or JSON-encoded as a string. */
export function findVegaSpec(obj, depth = 0) {
    if (obj == null || depth > 2)
        return null;
    if (typeof obj === "string") {
        if (obj.length > 20 && (obj.includes("$schema") || obj.includes('"mark"'))) {
            try {
                return findVegaSpec(JSON.parse(obj), depth + 1);
            }
            catch {
                return null;
            }
        }
        return null;
    }
    if (typeof obj !== "object")
        return null;
    const looksVega = (typeof obj.$schema === "string" && obj.$schema.includes("vega")) ||
        (("mark" in obj || "layer" in obj || "hconcat" in obj || "vconcat" in obj) &&
            ("encoding" in obj || "layer" in obj || "data" in obj));
    if (looksVega)
        return obj;
    for (const key of ["chart_spec", "chartSpec", "spec", "chart", "vega_lite_spec"]) {
        const found = findVegaSpec(obj[key], depth + 1);
        if (found)
            return found;
    }
    return null;
}
async function safeText(r) {
    try {
        return (await r.text()).slice(0, 300);
    }
    catch {
        return "";
    }
}
