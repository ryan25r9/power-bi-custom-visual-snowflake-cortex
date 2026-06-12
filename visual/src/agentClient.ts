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
 *   response.warning             {"message"}                              non-fatal warning
 *   response.text.annotation     {"annotation":{...}}                     citations
 *   response.chart               {"chart":{"chart_spec":...}}             chart block
 *   response.table               {"result_set":{...}}                     result-set block
 *   error                        {"message"}                              error
 * Unknown events are ignored by design (Snowflake adds types over time).
 */

export interface ChatMessage {
    role: "user" | "assistant";
    content: { type: "text"; text: string }[];
}

export interface StreamCallbacks {
    onStatus: (msg: string) => void;
    onTextDelta: (text: string) => void;
    onThinkingDelta: (text: string) => void;
    onToolUse: (name: string, toolType: string) => void;
    onToolStatus: (msg: string) => void;
    onSql: (sql: string) => void;
    onChart: (spec: object) => void;
    onDone: () => void;
    onError: (err: string) => void;
    // Optional — newer event types; absent handlers mean the event is ignored.
    onWarning?: (msg: string) => void;
    onAnnotation?: (annotation: Record<string, unknown>) => void;
    onTable?: (table: { columns: string[]; rows: unknown[][] }) => void;
}

export async function streamAgent(
    proxyUrl: string,
    proxyKey: string,
    messages: ChatMessage[],
    cb: StreamCallbacks,
    signal: AbortSignal
): Promise<void> {
    let resp: Response;
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
    } catch (e) {
        if ((e as Error).name === "AbortError") return;
        cb.onError(`Could not reach proxy. Check the Proxy URL setting and the WebAccess privilege in capabilities.json. (${(e as Error).message})`);
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
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE messages are separated by a blank line
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) handleBlock(block, cb);
        }
        buffer += decoder.decode(); // flush any trailing multi-byte sequence
        if (buffer.trim()) handleBlock(buffer, cb);
        cb.onDone();
    } catch (e) {
        if ((e as Error).name !== "AbortError") cb.onError((e as Error).message);
    }
}

/**
 * streamAgent with bounded exponential backoff for transient failures.
 * Retries ONLY while nothing has been delivered yet (no duplicated tokens,
 * charts, or tool activity), never on the AUTH sentinel, never after abort.
 */
export async function streamAgentWithRetry(
    proxyUrl: string,
    proxyKey: string,
    messages: ChatMessage[],
    cb: StreamCallbacks,
    signal: AbortSignal,
    maxRetries = 2,
    baseDelayMs = 1000
): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        let delivered = false;
        let failure: string | null = null;
        const deliver = <T extends unknown[]>(f: (...args: T) => void) =>
            (...args: T) => { delivered = true; f(...args); };

        await streamAgent(proxyUrl, proxyKey, messages, {
            onStatus: deliver(cb.onStatus),
            onTextDelta: deliver(cb.onTextDelta),
            onThinkingDelta: deliver(cb.onThinkingDelta),
            onToolUse: deliver(cb.onToolUse),
            onToolStatus: deliver(cb.onToolStatus),
            onSql: deliver(cb.onSql),
            onChart: deliver(cb.onChart),
            onDone: deliver(cb.onDone),
            onWarning: cb.onWarning && deliver(cb.onWarning),
            onAnnotation: cb.onAnnotation && deliver(cb.onAnnotation),
            onTable: cb.onTable && deliver(cb.onTable),
            onError: (e) => { failure = e; }
        }, signal);

        if (failure === null || signal.aborted) return; // success, or silent abort
        if (delivered || !isTransient(failure) || attempt >= maxRetries) {
            cb.onError(failure);
            return;
        }
        await abortableSleep(baseDelayMs * 2 ** attempt + Math.random() * 250, signal);
        if (signal.aborted) return;
    }
}

/** Matches streamAgent's own onError wording (same file, keep in sync). */
function isTransient(err: string): boolean {
    if (err === "AUTH") return false;                          // bad key: retrying can't help
    if (err.startsWith("Could not reach proxy.")) return true; // network-level fetch failure
    const m = /^Proxy error (\d+):/.exec(err);                 // pre-stream HTTP failure
    return m ? [429, 502, 503, 504].includes(Number(m[1])) : false;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        const finish = () => { signal.removeEventListener("abort", finish); clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, ms);
        if (signal.aborted) { finish(); return; }
        signal.addEventListener("abort", finish);
    });
}

function handleBlock(block: string, cb: StreamCallbacks): void {
    let event = "";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join("\n");
    if (raw === "[DONE]") return;

    let data: any;
    try { data = JSON.parse(raw); } catch { return; }

    switch (event) {
        case "response.text.delta":
            if (typeof data.text === "string") cb.onTextDelta(data.text);
            break;
        case "response.thinking.delta":
            if (typeof data.text === "string") cb.onThinkingDelta(data.text);
            break;
        case "response.status":
            if (typeof data.message === "string") cb.onStatus(data.message);
            break;
        case "response.tool_use":
            cb.onToolUse(String(data.name ?? data.type ?? "tool"), String(data.type ?? ""));
            break;
        case "response.tool_result.status":
            if (typeof data.message === "string") cb.onToolStatus(data.message);
            else if (typeof data.status === "string") cb.onToolStatus(data.status);
            break;
        case "response.tool_result":
            extractToolResult(data, cb);
            break;
        case "response.warning":
            if (typeof data.message === "string") cb.onWarning?.(data.message);
            break;
        case "response.text.annotation":
            if (data.annotation && typeof data.annotation === "object") cb.onAnnotation?.(data.annotation);
            break;
        case "response.chart": {
            // Documented shape nests the spec under "chart" (often as a JSON string);
            // unwrap first so findVegaSpec's depth limit isn't spent on the envelope.
            const spec = findVegaSpec(data.chart ?? data);
            if (spec) cb.onChart(spec);
            break;
        }
        case "response.table": {
            const table = extractResultSet(data);
            if (table) cb.onTable?.(table);
            break;
        }
        case "error":
            cb.onError(String(data.message ?? raw));
            break;
        default:
            break; // annotations, metadata, final response… ignored in v1
    }
}

/** Pull renderable artifacts (SQL, Vega-Lite charts) out of a tool_result payload. */
function extractToolResult(data: any, cb: StreamCallbacks): void {
    const items: any[] = Array.isArray(data?.content) ? data.content : [];
    for (const item of items) {
        if (item?.type !== "json" || item.json == null) continue;
        const j = item.json;

        const sql = j.sql ?? j.query ?? j.generated_sql;
        if (typeof sql === "string" && sql.trim()) cb.onSql(sql.trim());

        const spec = findVegaSpec(j);
        if (spec) cb.onChart(spec);
    }
}

/** Recognize a Vega-Lite spec directly, nested one level, or JSON-encoded as a string. */
export function findVegaSpec(obj: any, depth = 0): object | null {
    if (obj == null || depth > 2) return null;
    if (typeof obj === "string") {
        if (obj.length > 20 && (obj.includes("$schema") || obj.includes('"mark"'))) {
            try { return findVegaSpec(JSON.parse(obj), depth + 1); } catch { return null; }
        }
        return null;
    }
    if (typeof obj !== "object") return null;
    const looksVega =
        (typeof obj.$schema === "string" && obj.$schema.includes("vega")) ||
        (("mark" in obj || "layer" in obj || "hconcat" in obj || "vconcat" in obj) &&
         ("encoding" in obj || "layer" in obj || "data" in obj));
    if (looksVega) return obj;
    for (const key of ["chart_spec", "chartSpec", "spec", "chart", "vega_lite_spec"]) {
        const found = findVegaSpec(obj[key], depth + 1);
        if (found) return found;
    }
    return null;
}

/** Pull {columns, rows} out of a response.table payload (Snowflake SQL REST result_set shape). */
export function extractResultSet(data: any): { columns: string[]; rows: unknown[][] } | null {
    const rs = data?.result_set ?? data?.resultSet ?? data?.table;
    if (!rs || typeof rs !== "object") return null;
    const rowType = rs.resultSetMetaData?.rowType ?? rs.result_set_meta_data?.row_type;
    if (!Array.isArray(rowType) || !Array.isArray(rs.data)) return null;
    return { columns: rowType.map((r: any) => String(r?.name ?? "")), rows: rs.data };
}

async function safeText(r: Response): Promise<string> {
    try { return (await r.text()).slice(0, 300); } catch { return ""; }
}
