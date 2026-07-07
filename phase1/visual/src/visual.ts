/**
 * Snowflake Cortex Chat (M-Query, Phase 1) — Power BI custom visual.
 *
 * A proxy-free demo. The visual never calls Snowflake directly; instead it drives
 * a round-trip through the Power BI model/query layer:
 *
 *   1. On send, it builds the prompt (question + filtered report context) and
 *      pushes it as a Basic filter onto a hidden "binding" column that a Dynamic
 *      M Query Parameter is bound to (setup in phase1/README.md). The filter is
 *      applied at BOTH scopes — selfFilter (so our own query sees it) and the
 *      page-scope filter (visible in the Filters pane).
 *   2. That parameter change re-runs the DirectQuery answer query, whose native
 *      SQL runs the Cortex agent (SNOWFLAKE.CORTEX.DATA_AGENT_RUN) inline and
 *      returns the answer as a row of data. No Snowflake objects are created.
 *   3. On the next update(), the answer arrives in dataView under the "Answer
 *      text" role; the visual reads it and replaces the pending bubble.
 *
 * No Azure Function, no CORS, no streaming, no conversation memory — one
 * question, one round-trip, one answer.
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
import { buildContextBlock, readAnswerText } from "./contextBuilder";

// Fallback if the format-pane "Answer timeout (seconds)" setting is unset.
// Agent runs routinely take minutes (200s+ observed live), so stay generous.
const DEFAULT_ANSWER_TIMEOUT_SECS = 600;

export class Visual implements IVisual {
    private host: IVisualHost;
    private settings: VisualFormattingSettingsModel;
    private fmtService: FormattingSettingsService;

    private dataView?: DataView;
    private busy = false;
    private pendingBubble?: HTMLElement;
    private waitTimer?: number;
    private tickTimer?: number;
    private askedAt = 0;

    // DOM
    private root: HTMLElement;
    private statusEl: HTMLElement;
    private contextChip: HTMLElement;
    private messagesEl: HTMLElement;
    private inputEl: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.fmtService = new FormattingSettingsService();
        this.buildDom(options.element);
    }

    public update(options: VisualUpdateOptions): void {
        // Rendering events make exports (PDF/PowerPoint) wait for the visual.
        const events = this.host.eventService;
        events?.renderingStarted(options);
        try {
            this.settings = this.fmtService.populateFormattingSettingsModel(
                VisualFormattingSettingsModel, options.dataViews?.[0]);
            this.dataView = options.dataViews?.[0];
            this.refreshContextChip();

            // The answer arrives as a fresh data update after our filter re-ran the
            // query. Render it only on a data-bearing update while a question is in
            // flight, so resize/format updates don't trip it.
            const isDataUpdate = (options.type & powerbi.VisualUpdateType.Data) !== 0;
            if (this.busy && isDataUpdate) {
                const answer = readAnswerText(this.dataView);
                if (answer) this.finishTurn(answer);
            }

            events?.renderingFinished(options);
        } catch (e) {
            events?.renderingFailed(options, String(e));
            throw e;
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(this.settings);
    }

    public destroy(): void {
        if (this.waitTimer) window.clearTimeout(this.waitTimer);
        if (this.tickTimer) window.clearInterval(this.tickTimer);
    }

    // ---------- ask / answer ----------

    private send(): void {
        const question = this.inputEl.value.trim();
        if (!question || this.busy) return;

        this.busy = true;
        this.sendBtn.disabled = true;
        this.inputEl.value = "";
        this.addBubble("user", question);

        // Build the full prompt client-side, exactly like Phase 2 — but it now
        // travels through a Dynamic M parameter instead of an HTTP body.
        let prompt = question;
        if (this.settings.agentCard.includeContext.value) {
            const { block } = buildContextBlock(
                this.dataView,
                this.settings.agentCard.maxContextRows.value,
                this.settings.agentCard.agentHint.value);
            prompt = `${block}\n\nUSER QUESTION: ${question}`;
        }

        // Pending bubble pulses until the answer row returns in update().
        this.pendingBubble = this.addBubble("assistant", "Asking the agent…");
        this.pendingBubble.classList.add("cc-pending");
        // Elapsed ticker: agent runs take minutes, so show progress or the visual
        // looks frozen. Cleared in finishTurn().
        this.askedAt = Date.now();
        this.setStatus("Running in Snowflake — answers arrive all at once (no live typing).");
        if (this.tickTimer) window.clearInterval(this.tickTimer);
        this.tickTimer = window.setInterval(() => {
            const secs = Math.round((Date.now() - this.askedAt) / 1000);
            this.setStatus(`Running in Snowflake — ${secs}s elapsed. Agent runs can take a few minutes; the answer arrives all at once.`);
        }, 5000);

        // The round-trip: write the prompt as the selected value of the bound
        // column. The Dynamic M parameter picks it up and re-runs the answer query.
        // The value travels as data (a filter value into the M query), so we do
        // not escape it here — the M query handles quoting (see phase1/README.md).
        const table = this.settings.agentCard.bindingTable.value?.trim() || "PromptBinding";
        const column = this.settings.agentCard.bindingColumn.value?.trim() || "Prompt";
        // An ADVANCED "Is" filter — deliberately the exact shape proven to drive the
        // Dynamic M parameter when applied through the filter pane (a Basic "In" from
        // this API was observed NOT to reach Snowflake; see README field notes).
        const filter = {
            // eslint-disable-next-line powerbi-visuals/no-http-string -- canonical Power BI filter schema id, not a fetched URL
            $schema: "http://powerbi.com/product/schema#advanced",
            target: { table, column },
            filterType: 0,            // FilterType.Advanced
            logicalOperator: "And",
            conditions: [{ operator: "Is", value: prompt }]
        };
        // Apply at two scopes, and SURFACE any host rejection in the transcript —
        // applyJsonFilter failures are otherwise silent, which made this bug invisible.
        //   selfFilter -> our own query re-runs with the new parameter value
        //   filter     -> page scope (other visuals, e.g. a debug table)
        const surface = (scope: string) => (e: unknown) => {
            const msg = (e as { message?: string })?.message ?? String(e);
            this.addActivity(`⚠ ${scope} filter failed: ${msg}`);
        };
        for (const scope of ["selfFilter", "filter"] as const) {
            try {
                const r = this.host.applyJsonFilter(
                    filter as powerbi.IFilter, "general", scope, powerbi.FilterAction.merge);
                (r as unknown as { catch?: (f: (e: unknown) => void) => void })?.catch?.(surface(scope));
            } catch (e) {
                surface(scope)(e);
            }
        }

        // Safety net: if the query errors and no answer row ever lands, stop spinning.
        // Configurable (Format > Cortex Agent > Answer timeout) because agent runs
        // legitimately take minutes — a short timeout looks exactly like a broken pipeline.
        const timeoutSecs = Math.max(30,
            this.settings.agentCard.answerTimeout.value ?? DEFAULT_ANSWER_TIMEOUT_SECS);
        if (this.waitTimer) window.clearTimeout(this.waitTimer);
        this.waitTimer = window.setTimeout(() => {
            if (this.busy) this.finishTurn(
                `No answer after ${timeoutSecs}s. If Snowflake shows the query still running, raise "Answer timeout" in Format > Cortex Agent and ask again; otherwise check the model wiring / Snowflake connection.`);
        }, timeoutSecs * 1000);
    }

    private finishTurn(answer: string): void {
        if (this.waitTimer) { window.clearTimeout(this.waitTimer); this.waitTimer = undefined; }
        if (this.tickTimer) { window.clearInterval(this.tickTimer); this.tickTimer = undefined; }
        if (this.pendingBubble) {
            this.pendingBubble.classList.remove("cc-pending");
            this.pendingBubble.textContent = answer;   // textContent only — no HTML injection
            this.pendingBubble = undefined;
        } else {
            this.addBubble("assistant", answer);
        }
        this.busy = false;
        this.sendBtn.disabled = false;
        this.setStatus("");
        this.scrollDown();
    }

    // ---------- DOM ----------

    private buildDom(parent: HTMLElement): void {
        this.root = el("div", "cc-root", parent);

        const header = el("div", "cc-header", this.root);
        el("span", "cc-title", header).textContent = "❄ Cortex Agent";
        this.contextChip = el("span", "cc-chip", header);
        this.statusEl = el("div", "cc-status", this.root);

        this.messagesEl = el("div", "cc-messages", this.root);
        this.addBubble("assistant", "Hi! Ask me about the data on this page. I'll run your question against Snowflake and bring back an answer — it takes a few seconds, and arrives all at once (no live typing in this version).");

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

    /** Muted one-liner in the transcript — used to surface otherwise-silent errors. */
    private addActivity(text: string): void {
        el("div", "cc-activity", this.messagesEl).textContent = text;
        this.scrollDown();
    }

    private refreshContextChip(): void {
        const { summary } = buildContextBlock(this.dataView,
            this.settings?.agentCard.maxContextRows.value ?? 200, "");
        this.contextChip.textContent = summary.fieldCount
            ? `context: ${summary.fieldCount} fields · ${summary.rowCount} rows`
            : "no context fields bound";
        this.contextChip.title = "What the agent can currently see. Bind fields to 'Context fields' to expand it.";
    }

    private setStatus(msg: string): void { this.statusEl.textContent = msg; }
    private scrollDown(): void { this.messagesEl.scrollTop = this.messagesEl.scrollHeight; }
}

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
}
