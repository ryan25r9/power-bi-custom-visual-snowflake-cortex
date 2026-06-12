/**
 * Snowflake Cortex Chat — Power BI custom visual.
 *
 * Flow: update() caches the (already filtered) DataView ->
 * user asks a question -> contextBuilder serializes the current view ->
 * agentClient streams the answer through your proxy -> tokens render live.
 * Tool activity (incl. Cortex Analyst SQL) renders as a muted trail;
 * data_to_chart Vega-Lite specs render as inline charts.
 */
"use strict";

import "./../style/visual.less";
import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import DataView = powerbi.DataView;

import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualFormattingSettingsModel } from "./settings";
import { buildContextBlock } from "./contextBuilder";
import { streamAgentWithRetry, ChatMessage } from "./agentClient";
import vegaEmbed from "vega-embed";

const KEY_STORAGE = "cortexChatProxyKey";
const MAX_TURNS = 10; // history turns sent per request

export class Visual implements IVisual {
    private host: IVisualHost;
    private settings: VisualFormattingSettingsModel;
    private fmtService: FormattingSettingsService;

    private dataView?: DataView;
    private jsonFilters?: powerbi.IFilter[];
    private history: ChatMessage[] = [];
    private proxyKey = "";
    private busy = false;
    private abort?: AbortController;

    // DOM
    private root: HTMLElement;
    private statusEl: HTMLElement;
    private contextChip: HTMLElement;
    private messagesEl: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;
    private stopBtn: HTMLButtonElement;
    private keyRow: HTMLElement;
    private keyInput: HTMLInputElement;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.fmtService = new FormattingSettingsService();
        this.buildDom(options.element);
        this.loadKey();
    }

    public update(options: VisualUpdateOptions): void {
        this.settings = this.fmtService.populateFormattingSettingsModel(
            VisualFormattingSettingsModel, options.dataViews?.[0]);
        this.dataView = options.dataViews?.[0];
        this.jsonFilters = options.jsonFilters; // filters applied to this visual, when host supplies them
        this.refreshContextChip();

        const url = this.settings.agentCard.proxyUrl.value?.trim();
        this.setStatus(url ? "" : "Set the Proxy URL in Format ➜ Cortex Agent to begin.");
        this.sendBtn.disabled = !url || this.busy;
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(this.settings);
    }

    public destroy(): void {
        this.abort?.abort();
    }

    // ---------- chat ----------

    private async send(): Promise<void> {
        const question = this.inputEl.value.trim();
        const url = this.settings?.agentCard.proxyUrl.value?.trim();
        if (!question || !url || this.busy) return;

        this.busy = true;
        this.sendBtn.disabled = true;
        this.stopBtn.style.display = "";
        this.inputEl.value = "";
        this.addBubble("user", question);

        // Attach fresh report context to THIS turn only (older turns stay lean)
        let text = question;
        if (this.settings.agentCard.includeContext.value) {
            const { block } = buildContextBlock(
                this.dataView, this.jsonFilters,
                this.settings.agentCard.maxContextRows.value,
                this.settings.agentCard.agentHint.value);
            text = `${block}\n\nUSER QUESTION: ${question}`;
        }

        const turn: ChatMessage = { role: "user", content: [{ type: "text", text }] };
        const payload = [...this.history.slice(-MAX_TURNS), turn];
        this.history.push({ role: "user", content: [{ type: "text", text: question }] }); // store WITHOUT context

        // Assistant bubble is created lazily so tool-activity lines appear above the answer
        let bubble: HTMLElement | null = null;
        let answer = "";
        const ensureBubble = (): HTMLElement => bubble ?? (bubble = this.addBubble("assistant", ""));
        this.abort = new AbortController();

        await streamAgentWithRetry(url, this.proxyKey, payload, {
            onStatus: (m) => this.setStatus(m),
            onThinkingDelta: () => this.setStatus("Thinking…"),
            onToolUse: (name, type) => this.addActivity(`⚙ ${friendlyTool(type)} · ${name}`),
            onToolStatus: (m) => this.setStatus(m),
            onSql: (sql) => this.addSqlBlock(sql),
            onChart: (spec) => this.renderChart(spec),
            onWarning: (m) => this.addActivity(`⚠ ${m}`),
            onAnnotation: (a) => this.addAnnotation(a),
            onTable: (t) => this.renderTable(t),
            onTextDelta: (t) => { answer += t; ensureBubble().textContent = answer; this.scrollDown(); },
            onError: (e) => {
                if (e === "AUTH") { this.showKeyRow(); ensureBubble().textContent = "⚠ Enter your access key below, then ask again."; }
                else ensureBubble().textContent = `⚠ ${e}`;
            },
            onDone: () => {
                if (answer) this.history.push({ role: "assistant", content: [{ type: "text", text: answer }] });
            }
        }, this.abort.signal);

        this.setStatus("");
        this.busy = false;
        this.sendBtn.disabled = false;
        this.stopBtn.style.display = "none";
        this.scrollDown();
    }

    // ---------- per-user key (never stored in the report) ----------

    /** Local Storage v2 (api 5.11 removed the original storageService; keep it as a runtime fallback for older hosts). */
    private storage(): { get(k: string): powerbi.IPromise<string>; set(k: string, v: string): powerbi.IPromise<unknown> } | undefined {
        return this.host.storageV2Service ?? (this.host as any).storageService;
    }

    private loadKey(): void {
        try {
            this.storage()?.get(KEY_STORAGE)
                .then((v: string) => { if (v) this.proxyKey = v; })
                .catch(() => { /* not set yet, or LocalStorage disabled by admin */ });
        } catch { /* storage unavailable: key lives in memory for the session */ }
    }

    private saveKey(v: string): void {
        this.proxyKey = v;
        try { this.storage()?.set(KEY_STORAGE, v).catch(() => {}); } catch { /* in-memory only */ }
        this.keyRow.style.display = "none";
    }

    private showKeyRow(): void {
        this.keyRow.style.display = "flex";
        this.keyInput.focus();
        // If the admin switch disables visual storage, warn that the key is session-only.
        try {
            this.host.storageV2Service?.status()
                .then(s => {
                    if (s !== powerbi.PrivilegeStatus.Allowed) {
                        this.keyInput.placeholder = "Access key (not saved — re-enter each session)";
                    }
                })
                .catch(() => {});
        } catch { /* keep default placeholder */ }
    }

    // ---------- DOM ----------

    private buildDom(parent: HTMLElement): void {
        this.root = el("div", "cc-root", parent);

        const header = el("div", "cc-header", this.root);
        el("span", "cc-title", header).textContent = "❄ Cortex Agent";
        this.contextChip = el("span", "cc-chip", header);
        this.statusEl = el("div", "cc-status", this.root);

        this.messagesEl = el("div", "cc-messages", this.root);
        this.addBubble("assistant", "Hi! Ask me about the data on this page. I can see the fields bound to this visual, filtered to what you're currently viewing.");

        this.keyRow = el("div", "cc-keyrow", this.root);
        this.keyRow.style.display = "none";
        this.keyInput = el("input", "cc-keyinput", this.keyRow) as HTMLInputElement;
        this.keyInput.type = "password";
        this.keyInput.placeholder = "Access key (ask your report admin)";
        const keyBtn = el("button", "cc-btn", this.keyRow) as HTMLButtonElement;
        keyBtn.textContent = "Save";
        keyBtn.onclick = () => this.saveKey(this.keyInput.value.trim());

        const inputRow = el("div", "cc-inputrow", this.root);
        this.inputEl = el("textarea", "cc-input", inputRow) as HTMLTextAreaElement;
        this.inputEl.placeholder = "Ask about this data…";
        this.inputEl.rows = 2;
        this.inputEl.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
        };
        this.sendBtn = el("button", "cc-btn cc-send", inputRow) as HTMLButtonElement;
        this.sendBtn.textContent = "Send";
        this.sendBtn.onclick = () => this.send();

        this.stopBtn = el("button", "cc-btn cc-stop", inputRow) as HTMLButtonElement;
        this.stopBtn.textContent = "Stop";
        this.stopBtn.style.display = "none";
        this.stopBtn.onclick = () => this.abort?.abort();
        // Escape anywhere in the visual cancels the in-flight request too.
        this.root.addEventListener("keydown", (e) => {
            if (e.key === "Escape") this.abort?.abort();
        });
    }

    private addBubble(role: "user" | "assistant", text: string): HTMLElement {
        const b = el("div", `cc-bubble cc-${role}`, this.messagesEl);
        b.textContent = text;
        this.scrollDown();
        return b;
    }

    /** Muted one-liner in the transcript: tool calls, etc. */
    private addActivity(text: string): void {
        el("div", "cc-activity", this.messagesEl).textContent = text;
        this.scrollDown();
    }

    /** Collapsible "SQL used" block so analysts can audit the answer. */
    private addSqlBlock(sql: string): void {
        const details = el("details", "cc-sql", this.messagesEl) as HTMLDetailsElement;
        el("summary", "", details).textContent = "SQL used";
        el("pre", "", details).textContent = sql;
        this.scrollDown();
    }

    /** Render a data_to_chart Vega-Lite spec inline; fall back to the raw spec. */
    private renderChart(spec: object): void {
        const box = el("div", "cc-chart", this.messagesEl);
        const width = Math.max(220, this.messagesEl.clientWidth - 60);
        // ast:true -> vega-interpreter evaluates spec expressions (no Function());
        // specs are agent-supplied and untrusted, so never render without it.
        vegaEmbed(box, { width, height: 200, ...(spec as any) }, { actions: false, renderer: "svg", ast: true })
            .then(() => this.scrollDown())
            .catch(() => {
                box.classList.add("cc-chart-fallback");
                const pre = el("pre", "", box);
                pre.textContent = JSON.stringify(spec, null, 2).slice(0, 1500);
                this.scrollDown();
            });
    }

    /** Muted citation line for response.text.annotation events. */
    private addAnnotation(a: Record<string, unknown>): void {
        const parts = [a.doc_title, a.text].filter((s): s is string => typeof s === "string" && !!s);
        const label = parts.join(" — ") || String(a.doc_id ?? a.search_result_id ?? "citation");
        this.addActivity(`📎 Source: ${label}`);
    }

    /** Render a response.table result set as a real table (textContent only — no HTML injection). */
    private renderTable(t: { columns: string[]; rows: unknown[][] }): void {
        const MAX_TABLE_ROWS = 20;
        const wrap = el("div", "cc-table", this.messagesEl);
        const table = el("table", "", wrap);
        const headRow = el("tr", "", el("thead", "", table));
        for (const c of t.columns) el("th", "", headRow).textContent = c;
        const body = el("tbody", "", table);
        const take = Math.min(t.rows.length, MAX_TABLE_ROWS);
        for (let i = 0; i < take; i++) {
            const tr = el("tr", "", body);
            for (const v of t.rows[i]) el("td", "", tr).textContent = v == null ? "" : String(v);
        }
        if (t.rows.length > take) {
            el("div", "cc-table-more", wrap).textContent = `${t.rows.length - take} more rows`;
        }
        this.scrollDown();
    }

    private refreshContextChip(): void {
        const { summary } = buildContextBlock(this.dataView, this.jsonFilters,
            this.settings?.agentCard.maxContextRows.value ?? 200, "");
        this.contextChip.textContent = summary.fieldCount
            ? `context: ${summary.fieldCount} fields · ${summary.rowCount} rows${summary.filterCount ? ` · ${summary.filterCount} filters` : ""}`
            : "no fields bound";
        this.contextChip.title = "What the agent can currently see. Bind fields to 'Context fields' to expand it.";
    }

    private setStatus(msg: string): void { this.statusEl.textContent = msg; }
    private scrollDown(): void { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }
}

function friendlyTool(type: string): string {
    switch (type) {
        case "system_execute_sql":              // Apr 2026+: agents generate SQL directly
        case "cortex_analyst_text_to_sql":      // pre-Apr-2026 block type, kept for back-compat
            return "Querying data";
        case "cortex_search": return "Searching documents";
        case "data_to_chart": return "Building chart";
        case "web_search": return "Searching the web";
        default: return type || "Using tool";
    }
}

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
}
