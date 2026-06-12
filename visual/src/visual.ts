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
import { streamAgent, ChatMessage } from "./agentClient";
import vegaEmbed from "vega-embed";

const KEY_STORAGE = "cortexChatProxyKey";
const MAX_TURNS = 10; // history turns sent per request

export class Visual implements IVisual {
    private host: IVisualHost;
    private settings: VisualFormattingSettingsModel;
    private fmtService: FormattingSettingsService;

    private dataView?: DataView;
    private jsonFilters?: unknown[];
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
        this.jsonFilters = (options as any).jsonFilters; // filters applied to this visual, when host supplies them
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

        await streamAgent(url, this.proxyKey, payload, {
            onStatus: (m) => this.setStatus(m),
            onThinkingDelta: () => this.setStatus("Thinking…"),
            onToolUse: (name, type) => this.addActivity(`⚙ ${friendlyTool(type)} · ${name}`),
            onToolStatus: (m) => this.setStatus(m),
            onSql: (sql) => this.addSqlBlock(sql),
            onChart: (spec) => this.renderChart(spec),
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
        this.scrollDown();
    }

    // ---------- per-user key (never stored in the report) ----------

    private loadKey(): void {
        try {
            (this.host as any).storageService?.get(KEY_STORAGE)
                .then((v: string) => { if (v) this.proxyKey = v; })
                .catch(() => { /* not set yet, or LocalStorage disabled by admin */ });
        } catch { /* storage unavailable: key lives in memory for the session */ }
    }

    private saveKey(v: string): void {
        this.proxyKey = v;
        try { (this.host as any).storageService?.set(KEY_STORAGE, v).catch(() => {}); } catch { /* in-memory only */ }
        this.keyRow.style.display = "none";
    }

    private showKeyRow(): void { this.keyRow.style.display = "flex"; this.keyInput.focus(); }

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
        vegaEmbed(box, { width, height: 200, ...(spec as any) }, { actions: false, renderer: "svg" })
            .then(() => this.scrollDown())
            .catch(() => {
                box.classList.add("cc-chart-fallback");
                const pre = el("pre", "", box);
                pre.textContent = JSON.stringify(spec, null, 2).slice(0, 1500);
                this.scrollDown();
            });
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
