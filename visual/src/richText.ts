/**
 * Safe rich-text renderer for assistant answers.
 *
 * SECURITY CONTRACT (repo XSS posture — CLAUDE.md watch-list item 5):
 * agent output is UNTRUSTED. This module renders a markdown subset by building
 * DOM nodes exclusively with createElement / createTextNode / appendChild /
 * textContent / className. It never parses HTML: `innerHTML`, `outerHTML`,
 * `insertAdjacentHTML`, and `DOMParser` are forbidden here and everywhere in
 * the visual. Any tag-looking input (e.g. "<img onerror=...>") therefore
 * lands in the page as literal text, never as markup.
 *
 * Supported subset:
 *   paragraphs, **bold**, *italic*, `inline code`, ``` fenced code blocks,
 *   # / ## / ### headings, - and * bullet lists, 1. numbered lists,
 *   > blockquotes, [label](http(s)-url) links.
 *
 * Link policy: only http:// and https:// URLs become interactive; clicking
 * calls opts.onLink (the visual passes host.launchUrl — visuals may not
 * navigate directly). Any other scheme renders as plain text.
 *
 * Streaming-safe: unterminated markers (an open ``` fence, a dangling `**`)
 * render literally or as best-effort blocks and never throw, so the visual
 * can re-render the active bubble on every throttle tick.
 */

export interface RichTextOptions {
    /** Injectable for unit tests; defaults to the global document. */
    doc?: Document;
    /** Called with the validated http(s) URL when a link is clicked. */
    onLink?: (url: string) => void;
}

const HTTP_URL = /^https?:\/\//i;
const LINK_AT_START = /^\[([^\]\n]*)\]\(([^\s()]+)\)/;

export function renderRichText(text: string, opts: RichTextOptions = {}): DocumentFragment {
    const doc = opts.doc ?? document;
    const onLink = opts.onLink;
    const frag = doc.createDocumentFragment();
    const lines = String(text ?? "").split(/\r?\n/);

    let i = 0;
    let para: string[] = [];

    const flushPara = (): void => {
        if (!para.length) return;
        const p = doc.createElement("p");
        p.className = "rt-p";
        appendInline(p, para.join("\n"), doc, onLink);
        frag.appendChild(p);
        para = [];
    };

    while (i < lines.length) {
        const line = lines[i];

        // ``` fenced code block (content is raw text; no inline parsing)
        if (/^\s*```/.test(line)) {
            flushPara();
            const buf: string[] = [];
            i++;
            while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
            i++; // skip the closing fence (or run off the end mid-stream)
            const pre = doc.createElement("pre");
            pre.className = "rt-pre";
            const code = doc.createElement("code");
            code.textContent = buf.join("\n");
            pre.appendChild(code);
            frag.appendChild(pre);
            continue;
        }

        // # / ## / ### headings
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
            flushPara();
            const level = heading[1].length;
            const h = doc.createElement("h" + level);
            h.className = "rt-h rt-h" + level;
            appendInline(h, heading[2], doc, onLink);
            frag.appendChild(h);
            i++;
            continue;
        }

        // - / * bullet list (the space after the marker disambiguates from *italic*)
        if (/^\s*[-*]\s+\S/.test(line)) {
            flushPara();
            const ul = doc.createElement("ul");
            ul.className = "rt-list";
            while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i])) {
                const li = doc.createElement("li");
                appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ""), doc, onLink);
                ul.appendChild(li);
                i++;
            }
            frag.appendChild(ul);
            continue;
        }

        // 1. numbered list
        if (/^\s*\d+\.\s+\S/.test(line)) {
            flushPara();
            const ol = doc.createElement("ol");
            ol.className = "rt-list";
            while (i < lines.length && /^\s*\d+\.\s+\S/.test(lines[i])) {
                const li = doc.createElement("li");
                appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ""), doc, onLink);
                ol.appendChild(li);
                i++;
            }
            frag.appendChild(ol);
            continue;
        }

        // > blockquote (consecutive quoted lines merge into one block)
        if (/^\s*>\s?/.test(line)) {
            flushPara();
            const bq = doc.createElement("blockquote");
            bq.className = "rt-quote";
            const buf: string[] = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                buf.push(lines[i].replace(/^\s*>\s?/, ""));
                i++;
            }
            appendInline(bq, buf.join("\n"), doc, onLink);
            frag.appendChild(bq);
            continue;
        }

        // blank line = paragraph break
        if (!line.trim()) { flushPara(); i++; continue; }

        para.push(line);
        i++;
    }
    flushPara();
    return frag;
}

/**
 * Inline pass: `code`, **bold**, *italic*, [label](url). Everything else —
 * including anything tag-shaped — is emitted through createTextNode only.
 */
function appendInline(parent: Node, text: string, doc: Document, onLink?: (url: string) => void): void {
    let i = 0;
    let plain = "";
    const flush = (): void => {
        if (plain) { parent.appendChild(doc.createTextNode(plain)); plain = ""; }
    };

    while (i < text.length) {
        const ch = text[i];

        if (ch === "`") {
            const end = text.indexOf("`", i + 1);
            if (end > i) {
                flush();
                const code = doc.createElement("code");
                code.className = "rt-code";
                code.textContent = text.slice(i + 1, end);
                parent.appendChild(code);
                i = end + 1;
                continue;
            }
        } else if (ch === "*") {
            const double = text.startsWith("**", i);
            const marker = double ? "**" : "*";
            const start = i + marker.length;
            const end = text.indexOf(marker, start);
            const inner = end > -1 ? text.slice(start, end) : "";
            // Guards: non-empty, and no space hugging the markers ("2 * 3" stays literal).
            if (inner && inner.trim() && !/^\s/.test(inner) && !/\s$/.test(inner)) {
                flush();
                const el = doc.createElement(double ? "strong" : "em");
                appendInline(el, inner, doc, onLink);
                parent.appendChild(el);
                i = end + marker.length;
                continue;
            }
        } else if (ch === "[") {
            const m = LINK_AT_START.exec(text.slice(i));
            if (m && HTTP_URL.test(m[2])) {
                flush();
                const url = m[2];
                const a = doc.createElement("a") as HTMLElement & { onclick: (ev: Event) => boolean };
                a.className = "rt-link";
                a.textContent = m[1] || url;
                a.title = url;
                a.onclick = (ev: Event): boolean => {
                    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
                    if (onLink) onLink(url);
                    return false;
                };
                parent.appendChild(a);
                i += m[0].length;
                continue;
            }
            // Non-http(s) target (javascript:, data:, relative…) → falls through as literal text.
        }

        plain += ch;
        i++;
    }
    flush();
}
