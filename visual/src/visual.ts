/**
 * Snowflake Cortex Chat — Power BI custom visual (v2 UI).
 *
 * Flow: update() caches the (already filtered) DataView ->
 * user asks a question -> contextBuilder serializes the current view ->
 * agentClient streams the answer through the middleware -> tokens render live
 * through the safe rich-text renderer (DOM-built, never innerHTML).
 * Tool activity renders as compact chips; Cortex Analyst SQL as a collapsible
 * block with copy; data_to_chart Vega-Lite specs and result tables as cards.
 *
 * Session persistence: the transcript + a generated conversation id survive
 * page switches via storageV2 (same mechanism as the credential). Credentials
 * (shared key or bearer token) live ONLY in localStorage/memory — never in
 * the .pbix or format pane.
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
import { streamAgentWithRetry, ChatMessage, AgentConnection, AuthMode, AGENT_PROFILE_RX } from "./agentClient";
import { renderRichText } from "./richText";
import vegaEmbed from "vega-embed";

const KEY_STORAGE = "cortexChatProxyKey";        // shared-key credential (unchanged from v1)
const TOKEN_STORAGE = "cortexChatBearerToken";   // bearer-token credential
const SESSION_STORAGE = "cortexChatSession";     // persisted transcript + conversation id
const MAX_TURNS = 10;                            // history turns sent per request
const MAX_STORED_MESSAGES = 40;                  // persisted transcript cap (messages)
const MAX_STORED_BYTES = 200 * 1024;             // persisted transcript cap (serialized size)
const SAVE_DEBOUNCE_MS = 500;
const STREAM_RENDER_MS = 100;                    // rich-text re-render throttle while streaming

// ---------- persisted session schema (storageV2, JSON-serialized) ----------
// { v: 1, id: string, messages: StoredMessage[] } — capped to the last
// MAX_STORED_MESSAGES messages and MAX_STORED_BYTES serialized bytes.

interface StoredExtra {
    kind: "sql" | "chart" | "table";
    sql?: string;
    spec?: object;
    table?: { columns: string[]; rows: unknown[][] };
}

interface StoredMessage {
    role: "user" | "assistant";
    text: string;
    ts: number;
    extras?: StoredExtra[];
}

interface StoredSession {
    v: 1;
    id: string;
    messages: StoredMessage[];
}

export class Visual implements IVisual {
    private host: IVisualHost;
    private settings: VisualFormattingSettingsModel;
    private fmtService: FormattingSettingsService;

    private dataView?: DataView;
    private jsonFilters?: powerbi.IFilter[];
    private history: ChatMessage[] = [];
    private transcript: StoredMessage[] = [];
    private conversationId = "";
    private credKey = "";
    private credToken = "";
    private busy = false;
    private abort?: AbortController;
    private lastQuestion = "";
    private authRetryPending = false;

    private stick = true;                 // autoscroll glued to bottom?
    private hasUpdated = false;
    private pendingRestore?: StoredMessage[];
    private restored = false;
    private saveTimer?: number;
    private clockTimer?: number;
    private darkQuery?: MediaQueryList;
    private darkListener?: () => void;

    // DOM
    private root: HTMLElement;
    private titleEl: HTMLElement;
    private contextChip: HTMLElement;
    private newChatBtn: HTMLButtonElement;
    private messagesEl: HTMLElement;
    private welcomeEl: HTMLElement;
    private welcomeChips: HTMLElement;
    private welcomeContext: HTMLElement;
    private jumpBtn: HTMLButtonElement;
    private bannerEl: HTMLElement;
    private bannerText: HTMLElement;
    private statusEl: HTMLElement;
    private credRow: HTMLElement;
    private credHint: HTMLElement;
    private credInput: HTMLInputElement;
    private inputEl: HTMLTextAreaElement;
    private sendBtn: HTMLButtonElement;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.fmtService = new FormattingSettingsService();
        this.conversationId = genId();
        this.buildDom(options.element);
        this.loadCredentials();
        this.loadSession();
        this.applyTheme();

        try {
            this.darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
            this.darkListener = () => this.applyTheme();
            this.darkQuery?.addEventListener?.("change", this.darkListener);
        } catch { /* theme just won't live-switch */ }
        this.clockTimer = window.setInterval(() => this.refreshTimestamps(), 60_000);
    }

    public update(options: VisualUpdateOptions): void {
        // Rendering events make exports (PDF/PowerPoint) wait for the visual. They bracket
        // the synchronous DataView render only — never the async chat stream.
        const events = this.host.eventService;
        events?.renderingStarted(options);
        try {
            this.settings = this.fmtService.populateFormattingSettingsModel(
                VisualFormattingSettingsModel, options.dataViews?.[0]);
            this.dataView = options.dataViews?.[0];
            this.jsonFilters = options.jsonFilters; // filters applied to this visual, when host supplies them
            this.hasUpdated = true;

            this.applyTheme();
            this.titleEl.textContent = this.settings.appearanceCard.title.value?.trim() || "Cortex Agent";
            this.refreshContextChip();
            this.maybeRestore();
            this.refreshWelcome();
            this.refreshComposer();
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
        this.abort?.abort();
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = undefined; this.saveSession(); }
        if (this.clockTimer) clearInterval(this.clockTimer);
        if (this.darkQuery && this.darkListener) this.darkQuery.removeEventListener?.("change", this.darkListener);
    }

    // ---------- chat ----------

    private send(): void {
        if (this.busy) return; // keep the draft in the box while a stream is running
        const question = this.inputEl.value.trim();
        if (!question) return;
        this.inputEl.value = "";
        this.autosize();
        void this.ask(question);
    }

    private async ask(question: string, isRetry = false): Promise<void> {
        const url = this.settings?.agentCard.proxyUrl.value?.trim();
        if (!question || !url || this.busy) return;

        // Bad profile values would throw inside fetch (header ByteString) with a
        // misleading "unreachable" error — catch them here with the real cause.
        const agentProfile = this.settings.agentCard.agentProfile.value?.trim() || undefined;
        if (agentProfile && !AGENT_PROFILE_RX.test(agentProfile)) {
            this.showBanner("The Agent profile setting has unsupported characters — use letters, digits, hyphens, and underscores (Format › Cortex Agent › Agent profile).");
            return;
        }

        this.hideBanner();
        this.lastQuestion = question;

        if (!isRetry) {
            const ts = Date.now();
            this.history.push({ role: "user", content: [{ type: "text", text: question }] }); // store WITHOUT context
            this.transcript.push({ role: "user", text: question, ts });
            this.appendUserMessage(question, ts);
            this.scheduleSave();
        }

        // No credential yet? Prompt before burning a request on a guaranteed 401.
        if (!this.credential()) {
            this.authRetryPending = true;
            this.promptCredential();
            return;
        }

        this.busy = true;
        this.refreshComposer();
        this.stick = true;

        // Attach fresh report context to THIS turn only (older turns stay lean)
        let text = question;
        if (this.settings.agentCard.includeContext.value) {
            const { block } = buildContextBlock(
                this.dataView, this.jsonFilters,
                this.settings.agentCard.maxContextRows.value,
                this.settings.agentCard.agentHint.value);
            text = `${block}\n\nUSER QUESTION: ${question}`;
        }
        const prior = this.history.slice(0, -1).slice(-MAX_TURNS);
        const payload: ChatMessage[] = [...prior, { role: "user", content: [{ type: "text", text }] }];

        const turn = new AssistantTurn(this.messagesEl, (u) => this.host.launchUrl(u), (force) => this.scrollDown(force));
        let answer = "";
        let failure: string | null = null;
        this.abort = new AbortController();
        const convAtStart = this.conversationId; // "New chat" mid-stream must not leak into the new session
        const conn: AgentConnection = {
            url,
            authMode: this.authMode(),
            credential: this.credential(),
            conversationId: this.conversationId,
            agentProfile
        };

        await streamAgentWithRetry(conn, payload, {
            onStatus: (m) => this.setStatus(m),
            onThinkingDelta: () => this.setStatus("Thinking…"),
            onToolUse: (name, type) => turn.addTool(type, name),
            onToolStatus: (m) => this.setStatus(m),
            onSql: (sql) => turn.addSql(sql),
            onChart: (spec) => turn.addChart(spec),
            onWarning: (m) => turn.addNote(`Warning: ${m}`, "warn"),
            onAnnotation: (a) => turn.addNote(annotationLabel(a), "info"),
            onTable: (t) => turn.addTable(t),
            onTextDelta: (t) => { answer += t; turn.streamText(answer); },
            onError: (e) => { failure = e; },
            onDone: () => { /* transcript recorded below */ }
        }, this.abort.signal);

        turn.finish(answer, Date.now());
        this.setStatus("");
        this.busy = false;
        this.abort = undefined;
        this.refreshComposer();

        if (this.conversationId !== convAtStart) return; // superseded by "New chat"

        // Commit the turn only on success. A failed stream may have delivered a
        // partial answer (still visible in the DOM above the error banner), but it
        // must not enter history/transcript: the question's user turn stays the
        // LAST history entry, so a Retry rebuilds the payload with exactly one
        // copy of the question and no half-answer posing as a completed turn.
        if (!failure && (answer || turn.extras.length)) {
            if (answer) this.history.push({ role: "assistant", content: [{ type: "text", text: answer }] });
            this.transcript.push({
                role: "assistant", text: answer, ts: Date.now(),
                extras: turn.extras.length ? turn.extras : undefined
            });
            this.scheduleSave();
        }

        if (failure === "AUTH") {
            this.authRetryPending = true;
            this.promptCredential(true);
        } else if (failure) {
            this.showBanner(humanizeError(failure));
        }
        this.scrollDown();
    }

    private retryLast(): void {
        if (this.busy || !this.lastQuestion) return;
        this.hideBanner();
        void this.ask(this.lastQuestion, true);
    }

    private newChat(): void {
        this.abort?.abort();
        this.history = [];
        this.transcript = [];
        this.conversationId = genId();
        this.lastQuestion = "";
        this.authRetryPending = false;
        this.hideBanner();
        this.setStatus("");
        // Remove every transcript node; the welcome block (first child) stays.
        while (this.messagesEl.lastChild && this.messagesEl.lastChild !== this.welcomeEl) {
            this.messagesEl.removeChild(this.messagesEl.lastChild);
        }
        this.stick = true;
        this.refreshWelcome();
        this.saveSession(); // persist the cleared state + new id immediately
        this.inputEl.focus();
    }

    // ---------- auth (credential never stored in the report) ----------

    private authMode(): AuthMode {
        return (this.settings?.agentCard.authMode.value?.value === "bearer") ? "bearer" : "key";
    }

    private credential(): string {
        return this.authMode() === "bearer" ? this.credToken : this.credKey;
    }

    /** Local Storage v2 (api 5.11 removed the original storageService; keep it as a runtime fallback for older hosts). */
    private storage(): { get(k: string): powerbi.IPromise<string>; set(k: string, v: string): powerbi.IPromise<unknown> } | undefined {
        return this.host.storageV2Service ?? (this.host as any).storageService;
    }

    private loadCredentials(): void {
        try {
            this.storage()?.get(KEY_STORAGE)
                .then((v: string) => { if (v) this.credKey = v; })
                .catch(() => { /* not set yet, or LocalStorage disabled by admin */ });
            this.storage()?.get(TOKEN_STORAGE)
                .then((v: string) => { if (v) this.credToken = v; })
                .catch(() => { /* not set yet */ });
        } catch { /* storage unavailable: credentials live in memory for the session */ }
    }

    private saveCredential(v: string): void {
        if (!v) return;
        const bearer = this.authMode() === "bearer";
        if (bearer) this.credToken = v; else this.credKey = v;
        try { this.storage()?.set(bearer ? TOKEN_STORAGE : KEY_STORAGE, v).catch(() => {}); } catch { /* in-memory only */ }
        this.credRow.classList.remove("cc-show");
        this.credInput.value = "";
        if (this.authRetryPending && this.lastQuestion) {
            this.authRetryPending = false;
            void this.ask(this.lastQuestion, true);
        } else {
            this.inputEl.focus();
        }
    }

    private promptCredential(rejected = false): void {
        const bearer = this.authMode() === "bearer";
        const what = bearer ? "bearer token" : "access key";
        this.credHint.textContent = (rejected ? `That ${what} was rejected. ` : "") +
            `Enter the ${what} from your admin — it stays in this browser only.`;
        this.credInput.placeholder = bearer ? "Bearer token" : "Access key";
        this.credRow.classList.add("cc-show");
        this.credInput.focus();
        // If the admin switch disables visual storage, warn that the credential is session-only.
        try {
            this.host.storageV2Service?.status()
                .then(s => {
                    if (s !== powerbi.PrivilegeStatus.Allowed) {
                        this.credInput.placeholder = `${bearer ? "Bearer token" : "Access key"} (not saved — re-enter each session)`;
                    }
                })
                .catch(() => {});
        } catch { /* keep default placeholder */ }
    }

    // ---------- session persistence (storageV2; degrades to session-only) ----------

    private loadSession(): void {
        const finish = (): void => { this.maybeRestore(); this.refreshWelcome(); };
        try {
            const p = this.storage()?.get(SESSION_STORAGE);
            if (!p) { finish(); return; }
            p.then((raw: string) => {
                try {
                    // If the user beat the storage promise and already started
                    // chatting, the stored session is stale: adopting its id would
                    // orphan the in-flight answer (convAtStart check) and its
                    // messages would splice in AFTER newer ones. Abandon it.
                    const untouched = !this.busy && this.transcript.length === 0;
                    const s = raw ? JSON.parse(raw) as StoredSession : null;
                    if (untouched && s && s.v === 1 && Array.isArray(s.messages)) {
                        if (s.id) this.conversationId = s.id;
                        if (s.messages.length) this.pendingRestore = s.messages;
                    }
                } catch { /* corrupted blob: start fresh */ }
                finish();
            }).catch(finish);
        } catch { finish(); }
    }

    /** Restore waits for the first update() so chart widths reflect the real viewport. */
    private maybeRestore(): void {
        if (!this.pendingRestore || !this.hasUpdated || this.restored) return;
        if (this.busy || this.transcript.length > 0) { this.pendingRestore = undefined; return; } // conversation already started
        this.restored = true;
        const msgs = this.pendingRestore;
        this.pendingRestore = undefined;
        for (const m of msgs) {
            if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
            const text = typeof m.text === "string" ? m.text : "";
            if (m.role === "user") {
                this.appendUserMessage(text, m.ts);
                this.history.push({ role: "user", content: [{ type: "text", text }] });
            } else {
                const turn = new AssistantTurn(this.messagesEl, (u) => this.host.launchUrl(u), (force) => this.scrollDown(force));
                for (const ex of m.extras ?? []) {
                    if (ex.kind === "sql" && typeof ex.sql === "string") turn.addSql(ex.sql);
                    else if (ex.kind === "chart" && ex.spec) turn.addChart(ex.spec);
                    else if (ex.kind === "table" && ex.table) turn.addTable(ex.table);
                }
                turn.finish(text, m.ts);
                if (text) this.history.push({ role: "assistant", content: [{ type: "text", text }] });
            }
            this.transcript.push(m);
        }
        this.refreshWelcome();
        this.stick = true;
        this.scrollDown(true);
    }

    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => { this.saveTimer = undefined; this.saveSession(); }, SAVE_DEBOUNCE_MS);
    }

    private saveSession(): void {
        const msgs = this.transcript.slice(-MAX_STORED_MESSAGES);
        let json = JSON.stringify({ v: 1, id: this.conversationId, messages: msgs } as StoredSession);
        while (json.length > MAX_STORED_BYTES && msgs.length > 1) {
            msgs.shift(); // drop oldest until the blob fits
            json = JSON.stringify({ v: 1, id: this.conversationId, messages: msgs } as StoredSession);
        }
        try { this.storage()?.set(SESSION_STORAGE, json).catch(() => {}); } catch { /* session-only chat */ }
    }

    // ---------- DOM ----------

    private buildDom(parent: HTMLElement): void {
        this.root = el("div", "cc-root", parent);

        // Header: title + live context chip + New chat
        const header = el("div", "cc-header", this.root);
        const titleWrap = el("div", "cc-titlewrap", header);
        el("span", "cc-logo", titleWrap).textContent = "❄"; // the actual snowflake mark, Snowflake blue
        this.titleEl = el("span", "cc-title", titleWrap);
        this.titleEl.textContent = "Cortex Agent";
        this.contextChip = el("span", "cc-chip", header);
        this.newChatBtn = el("button", "cc-ghostbtn cc-newchat", header) as HTMLButtonElement;
        this.newChatBtn.appendChild(svgIcon(ICONS.plus));
        el("span", "cc-ghostbtn-label", this.newChatBtn).textContent = "New chat";
        this.newChatBtn.title = "Start a new conversation";
        this.newChatBtn.setAttribute("aria-label", "New chat");
        this.newChatBtn.onclick = () => this.newChat();

        // Transcript (scrollable) + floating jump-to-latest
        const transcriptWrap = el("div", "cc-transcript", this.root);
        this.messagesEl = el("div", "cc-messages", transcriptWrap);
        this.messagesEl.setAttribute("role", "log");
        this.messagesEl.setAttribute("aria-live", "polite");
        this.messagesEl.addEventListener("scroll", () => {
            const m = this.messagesEl;
            const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 48;
            this.stick = nearBottom;
            this.jumpBtn.classList.toggle("cc-show", !nearBottom);
        });

        // Empty state (first child; stays put, toggled via display)
        this.welcomeEl = el("div", "cc-welcome", this.messagesEl);
        el("span", "cc-welcome-ic", el("div", "cc-welcome-glyph", this.welcomeEl)).textContent = "❄";
        el("div", "cc-welcome-title", this.welcomeEl).textContent = "Ask about the data on this page";
        el("div", "cc-welcome-sub", this.welcomeEl).textContent =
            "Answers use the fields bound to this visual, filtered to what you're viewing.";
        this.welcomeContext = el("div", "cc-welcome-context", this.welcomeEl);
        this.welcomeChips = el("div", "cc-suggestions", this.welcomeEl);

        this.jumpBtn = el("button", "cc-jump", transcriptWrap) as HTMLButtonElement;
        this.jumpBtn.appendChild(svgIcon(ICONS.chevronDown));
        this.jumpBtn.title = "Jump to latest";
        this.jumpBtn.setAttribute("aria-label", "Jump to latest");
        this.jumpBtn.onclick = () => { this.stick = true; this.scrollDown(true); this.jumpBtn.classList.remove("cc-show"); };

        // Error banner (distinct from chat)
        this.bannerEl = el("div", "cc-banner", this.root);
        this.bannerEl.appendChild(svgIcon(ICONS.warning, "cc-banner-ic"));
        this.bannerText = el("span", "cc-banner-text", this.bannerEl);
        const retryBtn = el("button", "cc-ghostbtn cc-banner-retry", this.bannerEl) as HTMLButtonElement;
        retryBtn.textContent = "Retry";
        retryBtn.onclick = () => this.retryLast();
        const dismissBtn = el("button", "cc-ghostbtn cc-banner-dismiss", this.bannerEl) as HTMLButtonElement;
        dismissBtn.textContent = "Dismiss";
        dismissBtn.onclick = () => this.hideBanner();

        // Status line (tool/thinking progress)
        this.statusEl = el("div", "cc-status", this.root);

        // Credential prompt (hidden until needed)
        this.credRow = el("div", "cc-credrow", this.root);
        this.credHint = el("div", "cc-cred-hint", this.credRow);
        const credLine = el("div", "cc-cred-line", this.credRow);
        this.credInput = el("input", "cc-credinput", credLine) as HTMLInputElement;
        this.credInput.type = "password";
        this.credInput.placeholder = "Access key";
        this.credInput.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); this.saveCredential(this.credInput.value.trim()); }
        };
        const credBtn = el("button", "cc-btn", credLine) as HTMLButtonElement;
        credBtn.textContent = "Save";
        credBtn.onclick = () => this.saveCredential(this.credInput.value.trim());

        // Composer: auto-growing textarea + Send (becomes Stop while streaming)
        const composer = el("div", "cc-composer", this.root);
        this.inputEl = el("textarea", "cc-input", composer) as HTMLTextAreaElement;
        this.inputEl.placeholder = "Ask about this data…";
        this.inputEl.rows = 1;
        this.inputEl.setAttribute("aria-label", "Ask a question");
        this.inputEl.addEventListener("input", () => this.autosize());
        this.inputEl.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey && !(e as KeyboardEvent).isComposing) {
                e.preventDefault();
                this.send();
            }
        };
        this.sendBtn = el("button", "cc-sendbtn", composer) as HTMLButtonElement;
        this.sendBtn.appendChild(svgIcon(ICONS.send, "cc-ic-send"));
        this.sendBtn.appendChild(svgIcon(ICONS.stop, "cc-ic-stop"));
        this.sendBtn.title = "Send";
        this.sendBtn.setAttribute("aria-label", "Send");
        this.sendBtn.onclick = () => {
            if (this.busy) this.abort?.abort();
            else this.send();
        };

        // Escape anywhere in the visual cancels the in-flight request too.
        this.root.addEventListener("keydown", (e) => {
            if (e.key === "Escape") this.abort?.abort();
        });
    }

    private appendUserMessage(text: string, ts: number): void {
        const msg = el("div", "cc-msg cc-user", this.messagesEl);
        const bubble = el("div", "cc-bubble", msg);
        bubble.textContent = text;
        appendTimestamp(msg, ts);
        this.refreshWelcome();
        this.scrollDown();
    }

    private refreshWelcome(): void {
        const empty = this.transcript.length === 0 && !this.pendingRestore;
        this.welcomeEl.classList.toggle("cc-show", empty);
        if (!empty) return;

        // Context line
        const { summary } = buildContextBlock(this.dataView, this.jsonFilters,
            this.settings?.agentCard.maxContextRows.value ?? 200, "");
        this.welcomeContext.textContent = summary.fieldCount
            ? `context: ${summary.fieldCount} fields · ${summary.rowCount} rows`
            : "no fields bound yet — the agent answers without page context";

        // Suggested question chips (semicolon-separated format setting, max 4)
        this.welcomeChips.textContent = "";
        const raw = this.settings?.appearanceCard.suggestedQuestions.value ?? "";
        const questions = raw.split(";").map(s => s.trim()).filter(Boolean).slice(0, 4);
        for (const q of questions) {
            const chip = el("button", "cc-suggestion", this.welcomeChips) as HTMLButtonElement;
            chip.textContent = q;
            chip.onclick = () => { this.inputEl.value = q; this.autosize(); this.send(); };
        }
    }

    private refreshContextChip(): void {
        const { summary } = buildContextBlock(this.dataView, this.jsonFilters,
            this.settings?.agentCard.maxContextRows.value ?? 200, "");
        this.contextChip.textContent = summary.fieldCount
            ? `${summary.fieldCount} fields · ${summary.rowCount} rows${summary.filterCount ? ` · ${summary.filterCount} filters` : ""}`
            : "no fields bound";
        this.contextChip.title = "What the agent can currently see. Bind fields to 'Context fields' to expand it.";
    }

    private refreshComposer(): void {
        const url = this.settings?.agentCard.proxyUrl.value?.trim();
        this.root.classList.toggle("cc-busy", this.busy);
        this.sendBtn.classList.toggle("cc-stop", this.busy);
        this.sendBtn.title = this.busy ? "Stop" : "Send";
        this.sendBtn.setAttribute("aria-label", this.busy ? "Stop" : "Send");
        this.sendBtn.disabled = !url && !this.busy;
        this.inputEl.disabled = !url;
        this.inputEl.placeholder = url
            ? "Ask about this data…"
            : "Set the Endpoint URL in Format › Cortex Agent to begin";
    }

    private showBanner(msg: string): void {
        this.bannerText.textContent = msg;
        this.bannerEl.classList.add("cc-show");
    }

    private hideBanner(): void {
        this.bannerEl.classList.remove("cc-show");
    }

    private setStatus(msg: string): void {
        this.statusEl.textContent = msg;
        this.statusEl.classList.toggle("cc-show", !!msg);
    }

    private autosize(): void {
        this.inputEl.style.height = "auto";
        this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 96) + "px";
    }

    private scrollDown(force = false): void {
        if (force || this.stick) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            this.jumpBtn.classList.remove("cc-show");
        }
    }

    private refreshTimestamps(): void {
        const times = this.root.querySelectorAll(".cc-time");
        for (let i = 0; i < times.length; i++) {
            const t = times[i] as HTMLElement;
            const ts = Number(t.dataset.ts);
            if (ts) t.textContent = relTime(ts);
        }
    }

    // ---------- theming (CSS custom properties on the root element) ----------

    private applyTheme(): void {
        const palette = this.host.colorPalette;
        const style = this.root.style;
        const hc = !!palette?.isHighContrast;
        this.root.classList.toggle("cc-hc", hc);

        const HC_PROPS = ["--cc-bg", "--cc-surface", "--cc-surface-2", "--cc-text", "--cc-muted",
            "--cc-border", "--cc-danger", "--cc-danger-bg", "--cc-code-bg", "--cc-code-text"];

        if (hc) {
            // High contrast: host foreground/background only, hard strokes.
            const fg = palette.foreground?.value || "#ffffff";
            const bg = palette.background?.value || "#000000";
            const map: Record<string, string> = {
                "--cc-bg": bg, "--cc-surface": bg, "--cc-surface-2": bg,
                "--cc-text": fg, "--cc-muted": fg, "--cc-border": fg,
                "--cc-danger": fg, "--cc-danger-bg": bg,
                "--cc-code-bg": bg, "--cc-code-text": fg,
                "--cc-accent": fg, "--cc-on-accent": bg,
                "--cc-accent-soft": "transparent", "--cc-accent-faint": "transparent"
            };
            for (const k of Object.keys(map)) style.setProperty(k, map[k]);
            this.root.classList.remove("cc-dark");
            return;
        }
        for (const k of HC_PROPS) style.removeProperty(k);

        // Dark detection: report theme background when the host exposes it, else OS preference.
        const paletteBg = palette?.background?.value;
        const dark = isHexColor(paletteBg)
            ? luminance(paletteBg) < 0.45
            : !!this.darkQuery?.matches;
        this.root.classList.toggle("cc-dark", dark);

        // Accent from the format pane drives buttons, links, and the user-bubble tint.
        const accent = isHexColor(this.settings?.appearanceCard.accentColor.value?.value)
            ? this.settings.appearanceCard.accentColor.value.value
            : "#29B5E8";
        const rgb = hexToRgb(accent) ?? { r: 41, g: 181, b: 232 };
        style.setProperty("--cc-accent", accent);
        style.setProperty("--cc-on-accent", luminance(accent) > 0.55 ? "#1b1a19" : "#ffffff");
        style.setProperty("--cc-accent-soft", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${dark ? 0.24 : 0.14})`);
        style.setProperty("--cc-accent-faint", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);

        // Type scale from the format pane. Chat text is the root em base (every
        // smaller size in the stylesheet is em-relative, so it all scales together).
        const clampPx = (v: unknown, lo: number, hi: number, dflt: number): number => {
            const n = typeof v === "number" ? v : NaN;
            return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
        };
        style.setProperty("--cc-font", `${clampPx(this.settings?.appearanceCard.fontSize.value, 9, 24, 13)}px`);
        style.setProperty("--cc-title-size", `${clampPx(this.settings?.appearanceCard.titleFontSize.value, 10, 28, 15)}px`);
    }
}

// ---------- assistant turn: tool chips, SQL, chart/table cards, streamed bubble ----------

class AssistantTurn {
    /** Persisted artifacts (SQL / chart specs / tables) in arrival order. */
    public extras: StoredExtra[] = [];

    private rootEl: HTMLElement;
    private toolsRow?: HTMLElement;
    private bubble?: HTMLElement;
    private activeChip?: HTMLElement;
    private pendingText = "";
    private renderTimer?: number;
    private finished = false;

    constructor(
        messagesEl: HTMLElement,
        private onLink: (url: string) => void,
        private scroll: (force?: boolean) => void
    ) {
        this.rootEl = el("div", "cc-msg cc-assistant", messagesEl);
    }

    addTool(type: string, name: string): void {
        this.completeActiveTool();
        if (!this.toolsRow) this.toolsRow = el("div", "cc-tools", this.rootEl);
        const chip = el("span", "cc-tool cc-running", this.toolsRow);
        chip.appendChild(svgIcon(toolIcon(type), "cc-tool-ic"));
        const label = friendlyTool(type);
        el("span", "cc-tool-label", chip).textContent =
            name && name !== type && name !== label ? `${label} · ${name}` : label;
        el("span", "cc-tool-spin", chip);
        this.activeChip = chip;
        this.scroll();
    }

    /** Collapsible "SQL used" block so analysts can audit the answer. */
    addSql(sql: string): void {
        this.completeActiveTool();
        const details = el("details", "cc-sql", this.rootEl) as HTMLDetailsElement;
        const summary = el("summary", "cc-sql-summary", details);
        summary.appendChild(svgIcon(ICONS.database, "cc-sql-ic"));
        el("span", "cc-sql-title", summary).textContent = "SQL used";
        const copyBtn = el("button", "cc-copy", summary) as HTMLButtonElement;
        copyBtn.appendChild(svgIcon(ICONS.copy));
        el("span", "cc-copy-label", copyBtn).textContent = "Copy";
        copyBtn.title = "Copy SQL to clipboard";
        copyBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            copyToClipboard(sql, copyBtn);
        };
        el("pre", "cc-sql-pre", details).textContent = sql;
        this.extras.push({ kind: "sql", sql });
        this.scroll();
    }

    /** Render a data_to_chart Vega-Lite spec as a full-width card; fall back to the raw spec. */
    addChart(spec: object): void {
        this.completeActiveTool();
        const card = el("div", "cc-card", this.rootEl);
        const head = el("div", "cc-card-head", card);
        head.appendChild(svgIcon(ICONS.chart, "cc-card-ic"));
        el("span", "cc-card-title", head).textContent = "Chart";
        const body = el("div", "cc-card-body", card);
        const width = Math.max(220, this.rootEl.clientWidth - 70 || 0);
        // ast:true -> vega-interpreter evaluates spec expressions (no Function());
        // specs are agent-supplied and untrusted, so never render without it.
        vegaEmbed(body, { width, height: 200, ...(spec as any) }, { actions: false, renderer: "svg", ast: true })
            .then(() => this.scroll())
            .catch(() => {
                body.classList.add("cc-chart-fallback");
                const pre = el("pre", "", body);
                pre.textContent = JSON.stringify(spec, null, 2).slice(0, 1500);
                this.scroll();
            });
        this.extras.push({ kind: "chart", spec });
        this.scroll();
    }

    /** Render a response.table result set as a real table (textContent only — no HTML injection). */
    addTable(t: { columns: string[]; rows: unknown[][] }): void {
        this.completeActiveTool();
        const MAX_TABLE_ROWS = 20;
        const card = el("div", "cc-card", this.rootEl);
        const head = el("div", "cc-card-head", card);
        head.appendChild(svgIcon(ICONS.table, "cc-card-ic"));
        el("span", "cc-card-title", head).textContent =
            `Table · ${t.rows.length} row${t.rows.length === 1 ? "" : "s"}`;
        const wrap = el("div", "cc-card-body cc-table", card);
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
        this.extras.push({ kind: "table", table: t });
        this.scroll();
    }

    /** Muted one-liner (warnings, citations). Transient — not persisted. */
    addNote(text: string, kind: "warn" | "info"): void {
        const note = el("div", `cc-note cc-note-${kind}`, this.rootEl);
        note.appendChild(svgIcon(kind === "warn" ? ICONS.warning : ICONS.sparkle, "cc-note-ic"));
        el("span", "", note).textContent = text;
        this.scroll();
    }

    /** Streaming text: re-render the rich content on a throttle (trailing edge). */
    streamText(answer: string): void {
        this.completeActiveTool();
        this.pendingText = answer;
        this.ensureBubble().classList.add("cc-streaming");
        if (this.renderTimer === undefined) {
            this.renderBubble();
            this.renderTimer = window.setTimeout(() => {
                this.renderTimer = undefined;
                if (!this.finished) this.renderBubble();
            }, STREAM_RENDER_MS);
        }
    }

    /** Final render + timestamp; removes the whole turn if nothing arrived. */
    finish(answer: string, ts: number): void {
        this.finished = true;
        if (this.renderTimer !== undefined) { clearTimeout(this.renderTimer); this.renderTimer = undefined; }
        this.completeActiveTool();
        if (answer) {
            this.pendingText = answer;
            this.renderBubble();
        }
        this.bubble?.classList.remove("cc-streaming");
        if (!this.rootEl.childNodes.length) {
            this.rootEl.parentElement?.removeChild(this.rootEl);
            return;
        }
        appendTimestamp(this.rootEl, ts);
        this.scroll();
    }

    private ensureBubble(): HTMLElement {
        if (!this.bubble) this.bubble = el("div", "cc-bubble", this.rootEl);
        return this.bubble;
    }

    private renderBubble(): void {
        const b = this.ensureBubble();
        b.textContent = "";
        b.appendChild(renderRichText(this.pendingText, { onLink: this.onLink }));
        this.scroll();
    }

    private completeActiveTool(): void {
        const chip = this.activeChip;
        if (!chip) return;
        this.activeChip = undefined;
        chip.classList.remove("cc-running");
        chip.classList.add("cc-done");
        chip.appendChild(svgIcon(ICONS.check, "cc-tool-check"));
    }
}

// ---------- helpers ----------

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

function toolIcon(type: string): string[] {
    switch (type) {
        case "system_execute_sql":
        case "cortex_analyst_text_to_sql":
            return ICONS.database;
        case "cortex_search": return ICONS.search;
        case "data_to_chart": return ICONS.chart;
        case "web_search": return ICONS.globe;
        default: return ICONS.sparkle;
    }
}

function annotationLabel(a: Record<string, unknown>): string {
    const parts = [a.doc_title, a.text].filter((s): s is string => typeof s === "string" && !!s);
    return `Source: ${parts.join(" — ") || String(a.doc_id ?? a.search_result_id ?? "citation")}`;
}

function humanizeError(e: string): string {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return "You appear to be offline. Reconnect, then retry.";
    }
    if (e.startsWith("Could not reach")) {
        return "The assistant service is unreachable. Check the Endpoint URL (Format › Cortex Agent) and your network, then retry.";
    }
    const m = /^Proxy error (\d+)/.exec(e);
    if (m) return `The assistant service returned an error (HTTP ${m[1]}). Retry, or contact your report admin if it persists.`;
    return e;
}

function appendTimestamp(parent: HTMLElement, ts: number): void {
    const t = el("span", "cc-time", parent);
    t.dataset.ts = String(ts);
    t.textContent = relTime(ts);
    t.title = new Date(ts).toLocaleString();
}

function relTime(ts: number): string {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
}

function copyToClipboard(text: string, btn: HTMLButtonElement): void {
    const label = btn.querySelector(".cc-copy-label") as HTMLElement | null;
    const flash = (msg: string): void => {
        if (!label) return;
        const prev = "Copy";
        label.textContent = msg;
        setTimeout(() => { label.textContent = prev; }, 1200);
    };
    try {
        navigator.clipboard?.writeText(text)
            .then(() => flash("Copied"))
            .catch(() => flash("Copy failed"));
    } catch { flash("Copy failed"); }
}

/** Crypto-random 32-hex conversation id (pbiviz lint forbids Math.random). */
function genId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
}

function isHexColor(v: unknown): v is string {
    return typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    if (!isHexColor(hex)) return null;
    let h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

/** Cheap perceptual luminance 0..1 (enough for light/dark decisions). */
function luminance(hex: string): number {
    const rgb = hexToRgb(hex);
    if (!rgb) return 1;
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

// ---------- inline SVG icons (static path data only — never user input) ----------

const ICONS: Record<string, string[]> = {
    database: [
        "M2.5 4c0-1.1 2.46-2 5.5-2s5.5.9 5.5 2-2.46 2-5.5 2-5.5-.9-5.5-2Z",
        "M2.5 4v8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4",
        "M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2"
    ],
    search: ["M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z", "M10 10l4 4"],
    chart: ["M3 13.5V8", "M8 13.5V3.5", "M13 13.5V6"],
    globe: [
        "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0Z", "M2 8h12",
        "M8 2c1.8 1.6 2.7 3.7 2.7 6S9.8 12.4 8 14c-1.8-1.6-2.7-3.7-2.7-6S6.2 3.6 8 2Z"
    ],
    sparkle: ["M8 1.5l1.5 4 4 1.5-4 1.5L8 12.5l-1.5-4-4-1.5 4-1.5L8 1.5Z"],
    check: ["M3.5 8.5l3 3 6-6.5"],
    copy: ["M5.5 5.5h8v8h-8z", "M3.5 10.5v-8h8"],
    plus: ["M8 3v10", "M3 8h10"],
    send: ["M14.5 1.5 1.5 7l5 2 2 5.5 6-13Z", "M14.5 1.5 6.5 9"],
    stop: ["M4.5 4.5h7v7h-7z"],
    chevronDown: ["M4 6.5l4 4 4-4"],
    warning: ["M8 2.5l6 11H2l6-11Z", "M8 6.5v3", "M8 11.7v.01"],
    table: ["M2.5 3.5h11v9h-11z", "M2.5 6.5h11", "M6.5 6.5v6"]
};

const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(paths: string[], cls = "cc-ic"): SVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("class", cls);
    for (const d of paths) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        svg.appendChild(p);
    }
    return svg;
}

function el(tag: string, cls: string, parent: HTMLElement): HTMLElement {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    parent.appendChild(e);
    return e;
}
