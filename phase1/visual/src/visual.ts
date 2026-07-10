/**
 * Snowflake Cortex Chat (M-Query, Phase 1) — Power BI custom visual.
 *
 * A proxy-free demo. The visual never calls Snowflake directly; instead it drives
 * a round-trip through the Power BI model/query layer:
 *
 *   1. On send, it builds the prompt (question + filtered report context) and
 *      applies it as a filter onto a "binding" column that a Dynamic M Query
 *      Parameter is bound to (setup in phase1/README.md). A visual-applied
 *      filter has slicer semantics — it filters every OTHER visual, never the
 *      applier's own query — so the design is TWO instances: an input-only one
 *      (just the prompt column bound) that sends, and a display one (Answer
 *      text bound) whose query the filter re-runs.
 *   2. That parameter change re-runs the DirectQuery answer query, whose native
 *      SQL runs the Cortex agent (SNOWFLAKE.CORTEX.DATA_AGENT_RUN) inline and
 *      returns the answer as a row of data. No Snowflake objects are created.
 *   3. The display instance's next update() carries the answer under the
 *      "Answer text" role; it renders any NEW answer, busy or not.
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
import { buildContextBlock, readAnswerText, detectInputMode, findPromptSource, buildPromptFilter } from "./contextBuilder";

// Fallback if the format-pane "Answer timeout (seconds)" setting is unset.
// Agent runs routinely take minutes (200s+ observed live), so stay generous.
const DEFAULT_ANSWER_TIMEOUT_SECS = 600;

// Shown in the transcript's instance-load line so test screenshots prove which
// build ran and when each instance was (re)created — Desktop recreates visuals
// on every Close & Apply, wiping the transcript, and that wipe itself is
// diagnostic. KEEP IN SYNC with pbiviz.json "version".
const VISUAL_VERSION = "1.0.10.0";

export class Visual implements IVisual {
    private host: IVisualHost;
    private settings: VisualFormattingSettingsModel;
    private fmtService: FormattingSettingsService;

    private dataView?: DataView;
    private dataViews: DataView[] = [];
    private busy = false;
    private pendingBubble?: HTMLElement;
    private waitTimer?: number;
    private tickTimer?: number;
    private askedAt = 0;
    private lastSendAt = 0;        // diagnostics window — echo host filter state after any send
    private inputMode = false;     // true when only the promptField role is bound (input-only instance)
    private lastAnswer = "";       // last rendered answer, so unrelated updates don't re-render it

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
            this.dataViews = options.dataViews ?? [];
            this.dataView = this.dataViews[0];
            this.inputMode = detectInputMode(this.dataViews,
                this.settings.agentCard.forceInputMode.value);
            if (this.inputMode) {
                this.contextChip.textContent = "input mode";
                this.contextChip.title = "This instance only sends questions. Answers appear in the display instance (the one with Answer text bound).";
            } else {
                this.refreshContextChip();
                // A display instance without the answer column can never show an
                // answer — make that misconfiguration visible in screenshots.
                const hasAnswerRole = this.dataViews.some(dv =>
                    !!dv?.metadata?.columns?.some(c => !!c.roles?.["answerText"]));
                if (!hasAnswerRole && !this.busy) {
                    this.setStatus("⚠ No 'Answer text' field bound — answers cannot display in this instance.");
                }
            }

            // DIAGNOSTIC: show what the host says our filter state is. options.jsonFilters
            // echoes the filters the host has actually persisted for this visual — the
            // decisive signal for whether applyJsonFilter took effect. Window it to two
            // minutes after a send so the input instance (which is never "busy") echoes too.
            if (this.busy || (this.lastSendAt && Date.now() - this.lastSendAt < 120_000)) {
                const echoed = JSON.stringify(options.jsonFilters ?? []);
                this.addActivity(`ⓘ update type=${options.type}, host filter state: ${echoed.slice(0, 220)}${echoed.length > 220 ? "…" : ""}`);
            }

            // The answer arrives as a fresh data update after the filter re-ran the query.
            // Render ANY new non-empty answer — whether this instance asked the question,
            // a separate input instance did, or the answer was already in flight when this
            // instance initialized. Desktop RECREATES visuals on every Power Query
            // Close & Apply, so the old "baseline the first data update" guard (≤1.0.8.0)
            // swallowed exactly the answer it was waiting for (proven live: the answer
            // rendered in a native debug table while the chat stayed silent). Quiet
            // report-opens are the idle sentinel's job (__no_prompt__ → NULL answer),
            // not a baseline's.
            // Accepted edges: a transiently-empty dataview resets the dedupe, so the same
            // answer can re-render once (cosmetic); two different questions with
            // byte-identical answers dedupe silently — a per-send reset would let a stale
            // mid-flight data update falsely complete the new turn, which is worse.
            const isDataUpdate = (options.type & powerbi.VisualUpdateType.Data) !== 0;
            if (!this.inputMode && isDataUpdate) {
                const answer = readAnswerText(this.dataView);
                const rows = this.dataView?.table?.rows?.length ?? 0;
                // One transcript line per data arrival: what came in and what this
                // visual decided to do with it. This is the display-side counterpart
                // of the input instance's filter-state echo — together the two
                // screenshots reconstruct a whole test round.
                const snippet = answer
                    ? `"${answer.slice(0, 60)}${answer.length > 60 ? "…" : ""}"`
                    : "empty (IDLE row or no answer column)";
                if (answer && answer !== this.lastAnswer) {
                    this.addActivity(`ⓘ data: ${rows} row(s), ANSWER_TEXT ${snippet} → rendering`);
                    this.lastAnswer = answer;
                    this.finishTurn(answer);
                } else if (!answer) {
                    // IDLE row (filters cleared / parameter back to the sentinel):
                    // reset the dedupe so re-asking the same question renders again.
                    this.addActivity(`ⓘ data: ${rows} row(s), ANSWER_TEXT ${snippet} → dedupe reset`);
                    this.lastAnswer = "";
                } else {
                    this.addActivity(`ⓘ data: ${rows} row(s), ANSWER_TEXT ${snippet} → same as last, skipped`);
                }
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
        if (this.busy) return;
        const question = this.inputEl.value.trim();
        // Empty Send = reset: remove this visual's persisted prompt filters. Stale
        // filters (an old question still merged in) otherwise linger in the .pbix
        // and can make the parameter unresolvable when a new value arrives.
        if (!question) { this.clearPromptFilters(); return; }

        this.lastSendAt = Date.now();
        this.busy = true;
        this.sendBtn.disabled = true;
        this.inputEl.value = "";
        this.addBubble("user", question);

        // Build the full prompt client-side, exactly like Phase 2 — but it now
        // travels through a Dynamic M parameter instead of an HTTP body.
        let prompt = question;
        if (!this.inputMode && this.settings.agentCard.includeContext.value) {
            const { block } = buildContextBlock(
                this.dataView,
                this.settings.agentCard.maxContextRows.value,
                this.settings.agentCard.agentHint.value);
            prompt = `${block}\n\nUSER QUESTION: ${question}`;
        }
        // The visual renders plain text only (textContent — the XSS posture), so ask
        // the agent not to send markdown it can't display.
        prompt += "\n\nFormat the answer as plain sentences. Do not use markdown formatting or markdown tables.";
        // The M query inlines the prompt inside a $$...$$ literal; a literal "$$"
        // anywhere in it (question or context cell values) would terminate the
        // literal and break the SQL. Transport constraint, not sanitization.
        prompt = prompt.replace(/\$\$/g, "$ $");

        // The round-trip: write the prompt as the selected value of the bound
        // column. The Dynamic M parameter picks it up and re-runs the answer query.
        // The value travels as data (a filter value into the M query), so we do
        // not escape it here — the M query handles quoting (see phase1/README.md).
        const { table, column } = this.promptTarget();
        const filter = buildPromptFilter(table, column, prompt);
        // Outbound scope ONLY. A visual's applied filter never enters its own query
        // (slicer semantics — three live tests), so selfFilter buys nothing; worse,
        // builds ≤1.0.5.0 left stale selfFilters (an old question) persisted on this
        // visual, poisoning its own filter context with a conflicting value. Clear
        // that scope on every send, then merge the new outbound filter.
        this.applyFilter(filter, "selfFilter", powerbi.FilterAction.remove);
        this.applyFilter(filter, "filter", powerbi.FilterAction.merge);

        // Input-only instance: it never receives the answer (that lands in the display
        // instance's dataView), so acknowledge and reset instead of spinning.
        if (this.inputMode) {
            this.addActivity("Question sent — the answer appears in the chat display instance.");
            this.busy = false;
            this.sendBtn.disabled = false;
            return;
        }

        // Display mode: pending bubble pulses until the answer row returns in update().
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

    // ---------- filter plumbing ----------

    /**
     * Filter target for the prompt column: derived from the bound field's queryName
     * when the column is bound (the lineage every working filter visual uses), else
     * the names typed in the format pane.
     */
    private promptTarget(): { table: string; column: string } {
        let table = this.settings?.agentCard.bindingTable.value?.trim() || "PromptBinding";
        let column = this.settings?.agentCard.bindingColumn.value?.trim() || "Prompt";
        const bound = findPromptSource(this.dataViews);
        if (bound?.queryName?.includes(".")) {
            table = bound.queryName.slice(0, bound.queryName.indexOf("."));
            column = bound.displayName || column;
        }
        return { table, column };
    }

    /**
     * applyJsonFilter with synchronous throws surfaced in the transcript. The API
     * returns VOID (not a promise) — asynchronous rejections are swallowed by
     * design, so the only positive observable is the options.jsonFilters echo on
     * subsequent updates (the ⓘ lines). Earlier builds chained .then/.catch here;
     * that was dead code and its "acknowledged by host" lines could never print.
     */
    private applyFilter(filter: powerbi.IFilter, scope: "filter" | "selfFilter",
        action: powerbi.FilterAction): void {
        const label = `${scope}${action === powerbi.FilterAction.remove ? " clear" : ""}`;
        try {
            this.host.applyJsonFilter(filter, "general", scope, action);
        } catch (e) {
            const msg = (e as { message?: string })?.message ?? String(e);
            this.addActivity(`⚠ ${label} failed: ${msg}`);
        }
    }

    /** Empty Send: remove this visual's persisted prompt filters at both scopes. */
    private clearPromptFilters(): void {
        const { table, column } = this.promptTarget();
        const f = buildPromptFilter(table, column, "");
        this.applyFilter(f, "filter", powerbi.FilterAction.remove);
        this.applyFilter(f, "selfFilter", powerbi.FilterAction.remove);
        this.lastSendAt = Date.now();
        this.addActivity("Prompt filters cleared for this visual (Send with an empty box does this).");
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
        // Screenshots must prove which build ran and when this instance was born.
        // A repeat of this line mid-session = the host recreated the visual
        // (typical cause: Power Query Close & Apply) and wiped the transcript.
        this.addActivity(`ⓘ Cortex Chat v${VISUAL_VERSION} — new instance (transcript starts here)`);

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
        // Local wall-clock prefix: analysts debug from screenshots, and the
        // sequencing of these lines is often the whole story.
        el("div", "cc-activity", this.messagesEl).textContent = `${nowHMS()} ${text}`;
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

function nowHMS(): string {
    return new Date().toTimeString().slice(0, 8);
}
