/**
 * Mock Snowflake Cortex Agents `agent:run` endpoint.
 * Plain node:http SSE server on 127.0.0.1:8043 — no dependencies.
 *
 *   POST /api/v2/databases/AI_DB/schemas/AGENTS/agents/REPORT_CHAT_AGENT:run
 *     Authorization must be "Bearer TEST_PAT" → otherwise 401 JSON.
 *     On success: streams Snowflake-documented SSE events with ~80ms gaps.
 */
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = 8043;
const AGENT_PATH = "/api/v2/databases/AI_DB/schemas/AGENTS/agents/REPORT_CHAT_AGENT:run";

const CHART_SPEC = {
    "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
    "mark": "bar",
    "data": { "values": [{ "r": "West", "s": 100 }, { "r": "East", "s": 80 }] },
    "encoding": {
        "x": { "field": "r", "type": "nominal" },
        "y": { "field": "s", "type": "quantitative" }
    }
};

// [eventName, dataObject] in the exact order Snowflake documents for agent:run.
const EVENTS = [
    ["response.status",
        { message: "Planning the next steps", status: "planning" }],
    ["response.thinking.delta",
        { content_index: 0, text: "Looking at the context" }],
    ["response.tool_use",
        { content_index: 0, tool_use_id: "toolu_1", type: "cortex_analyst_text_to_sql", name: "Analyst1", input: { query: "top regions by sales" } }],
    ["response.tool_result.status",
        { tool_use_id: "toolu_1", tool_type: "cortex_analyst_text_to_sql", status: "executing_sql", message: "Executing SQL" }],
    ["response.tool_result",
        { content_index: 0, tool_use_id: "toolu_1", type: "cortex_analyst_text_to_sql", name: "Analyst1", status: "success", content: [{ type: "json", json: { sql: "SELECT region, SUM(sales) s FROM t GROUP BY 1 ORDER BY 2 DESC", text: "query ran" } }] }],
    ["response.text.delta",
        { content_index: 1, text: "West leads ", is_elicitation: false }],
    ["response.text.delta",
        { content_index: 1, text: "all regions ", is_elicitation: false }],
    ["response.text.delta",
        { content_index: 1, text: "with 100 ", is_elicitation: false }],
    ["response.text.delta",
        { content_index: 1, text: "in sales.", is_elicitation: false }],
    ["response.tool_use",
        { content_index: 2, tool_use_id: "toolu_2", type: "data_to_chart", name: "data_to_chart", input: {} }],
    ["response.tool_result",
        { content_index: 2, tool_use_id: "toolu_2", type: "data_to_chart", name: "data_to_chart", status: "success", content: [{ type: "json", json: { chart_spec: CHART_SPEC } }] }]
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
    // Drain the request body before answering.
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
        if (req.method !== "POST" || req.url !== AGENT_PATH) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "not found", request_url: req.url }));
            return;
        }
        if (req.headers["authorization"] !== "Bearer TEST_PAT") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: "390303", message: "Invalid OAuth access token." }));
            return;
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        });
        for (const [name, data] of EVENTS) {
            res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
            await sleep(80);
        }
        res.end();
    });
});

server.listen(PORT, HOST, () => {
    console.log(`mock-snowflake listening on http://${HOST}:${PORT}${AGENT_PATH}`);
});
