/**
 * Unit tests for visual/src/richText.ts — renderRichText().
 * Compile first with: proxy/node_modules/.bin/tsc -p tests/tsconfig.json
 * (or just run tests/run-tests.sh).
 *
 * The stub Document below exposes ONLY what the renderer is allowed to use
 * (createElement / createTextNode / createDocumentFragment, appendChild,
 * textContent, className, event-handler properties). innerHTML / outerHTML /
 * insertAdjacentHTML THROW on the stub, so any HTML-parsing regression in the
 * renderer fails these tests immediately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderRichText } from "./build/richText.js";

// ---------- stub DOM ----------

function forbidHtmlParsing(node) {
    for (const prop of ["innerHTML", "outerHTML"]) {
        Object.defineProperty(node, prop, {
            get() { throw new Error(`${prop} is forbidden (XSS posture)`); },
            set() { throw new Error(`${prop} is forbidden (XSS posture)`); }
        });
    }
    node.insertAdjacentHTML = () => { throw new Error("insertAdjacentHTML is forbidden (XSS posture)"); };
}

function makeTextNode(s) {
    return {
        nodeType: 3,
        nodeName: "#text",
        data: String(s),
        get textContent() { return this.data; }
    };
}

function makeElement(tag) {
    const el = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        children: [],
        className: "",
        appendChild(child) { this.children.push(child); return child; },
        get textContent() {
            return this.children.map(c => c.textContent).join("");
        },
        set textContent(v) { this.children = [makeTextNode(v)]; }
    };
    forbidHtmlParsing(el);
    return el;
}

function makeFragment() {
    const frag = {
        nodeType: 11,
        nodeName: "#document-fragment",
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        get textContent() { return this.children.map(c => c.textContent).join(""); }
    };
    forbidHtmlParsing(frag);
    return frag;
}

function stubDoc() {
    const doc = {
        createElement: (tag) => makeElement(tag),
        createTextNode: (s) => makeTextNode(s),
        createDocumentFragment: () => makeFragment()
    };
    forbidHtmlParsing(doc);
    return doc;
}

/** Depth-first list of all element nodes under a node. */
function elements(node, out = []) {
    for (const c of node.children ?? []) {
        if (c.nodeType === 1) { out.push(c); elements(c, out); }
    }
    return out;
}

function byTag(node, tagName) {
    return elements(node).filter(e => e.tagName === tagName.toUpperCase());
}

function render(text, opts = {}) {
    return renderRichText(text, { doc: stubDoc(), ...opts });
}

// ---------- structure ----------

test("rt1. paragraphs with bold / italic / inline code produce the right nodes", () => {
    const frag = render("Hello **world** and *values* and `SUM(x)` end.\n\nSecond para.");
    const paras = byTag(frag, "p");
    assert.equal(paras.length, 2, "blank line splits paragraphs");

    const [strong] = byTag(paras[0], "strong");
    assert.ok(strong, "**...** becomes <strong>");
    assert.equal(strong.textContent, "world");

    const [em] = byTag(paras[0], "em");
    assert.ok(em, "*...* becomes <em>");
    assert.equal(em.textContent, "values");

    const [code] = byTag(paras[0], "code");
    assert.ok(code, "`...` becomes <code>");
    assert.equal(code.textContent, "SUM(x)");
    assert.equal(code.className, "rt-code");

    assert.equal(paras[0].textContent, "Hello world and values and SUM(x) end.");
    assert.equal(paras[1].textContent, "Second para.");
});

test("rt2. # / ## / ### headings map to h1/h2/h3; #### stays a paragraph", () => {
    const frag = render("# Top\n## Mid\n### Small\n#### NotAHeading");
    assert.equal(byTag(frag, "h1")[0]?.textContent, "Top");
    assert.equal(byTag(frag, "h2")[0]?.textContent, "Mid");
    assert.equal(byTag(frag, "h3")[0]?.textContent, "Small");
    assert.equal(byTag(frag, "h4").length, 0);
    assert.ok(byTag(frag, "p").some(p => p.textContent.includes("#### NotAHeading")));
});

test("rt3. bullet and numbered lists", () => {
    const frag = render("- alpha\n* beta\n\n1. one\n2. two\n3. three");
    const ul = byTag(frag, "ul")[0];
    assert.ok(ul, "- items produce <ul>");
    assert.deepEqual(byTag(ul, "li").map(li => li.textContent), ["alpha", "beta"]);

    const ol = byTag(frag, "ol")[0];
    assert.ok(ol, "1. items produce <ol>");
    assert.deepEqual(byTag(ol, "li").map(li => li.textContent), ["one", "two", "three"]);
});

test("rt4. fenced code block: raw text, no inline parsing, fence kept out", () => {
    const src = "```sql\nSELECT *  -- **not bold**\nFROM t\n```\nafter";
    const frag = render(src);
    const pre = byTag(frag, "pre")[0];
    assert.ok(pre, "``` produces <pre>");
    const code = byTag(pre, "code")[0];
    assert.equal(code.textContent, "SELECT *  -- **not bold**\nFROM t");
    assert.equal(byTag(pre, "strong").length, 0, "no inline parsing inside code fences");
    assert.ok(byTag(frag, "p").some(p => p.textContent === "after"));
});

test("rt5. unterminated fence (mid-stream) renders as a code block without throwing", () => {
    const frag = render("```\nSELECT 1");
    const pre = byTag(frag, "pre")[0];
    assert.ok(pre);
    assert.equal(pre.textContent, "SELECT 1");
});

test("rt6. blockquote merges consecutive > lines", () => {
    const frag = render("> first line\n> second line\nplain after");
    const bq = byTag(frag, "blockquote")[0];
    assert.ok(bq);
    assert.equal(bq.textContent, "first line\nsecond line");
    assert.ok(byTag(frag, "p").some(p => p.textContent === "plain after"));
});

test("rt7. italic guard: '2 * 3 * 4' stays literal text", () => {
    const frag = render("2 * 3 * 4 = 24");
    assert.equal(byTag(frag, "em").length, 0);
    assert.equal(frag.textContent, "2 * 3 * 4 = 24");
});

// ---------- link policy ----------

test("rt8. http(s) links become interactive and route through onLink only", () => {
    const clicked = [];
    const frag = render(
        "See [docs](https://learn.microsoft.com/power-bi) and [plain](http://example.com).",
        { onLink: (url) => clicked.push(url) });
    const links = byTag(frag, "a");
    assert.equal(links.length, 2);
    assert.equal(links[0].textContent, "docs");
    assert.equal(links[0].className, "rt-link");

    // Clicking calls onLink with the URL and suppresses default navigation.
    let prevented = false;
    const ret = links[0].onclick({ preventDefault: () => { prevented = true; } });
    assert.deepEqual(clicked, ["https://learn.microsoft.com/power-bi"]);
    assert.equal(prevented, true, "click handler must preventDefault");
    assert.equal(ret, false, "click handler must return false");
});

test("rt9. non-http(s) URLs never become links (javascript:, data:, relative)", () => {
    const cases = [
        "[x](javascript:alert(1))",
        "[x](JAVASCRIPT:alert(1))",
        "[x](data:text/html;base64,PHNjcmlwdD4=)",
        "[x](vbscript:msgbox)",
        "[x](/relative/path)",
        "[x](ftp://host/file)"
    ];
    for (const src of cases) {
        const frag = render(src);
        assert.equal(byTag(frag, "a").length, 0, `no <a> for ${src}`);
        assert.equal(frag.textContent, src, `literal text preserved for ${src}`);
    }
});

// ---------- injection resistance ----------

test("rt10. HTML tags in input come out as literal text nodes, never elements", () => {
    const payloads = [
        "<img src=x onerror=alert(1)>",
        "</div><script>alert(1)</script>",
        "<svg/onload=alert(1)>",
        "before <b>not-bold</b> after"
    ];
    for (const p of payloads) {
        const frag = render(p);
        const tags = elements(frag).map(e => e.tagName);
        for (const bad of ["IMG", "SCRIPT", "DIV", "SVG", "B"]) {
            assert.ok(!tags.includes(bad), `no <${bad}> element for input: ${p}`);
        }
        assert.equal(frag.textContent, p, `payload survives verbatim as text: ${p}`);
    }
});

test("rt11. HTML inside markdown constructs is still text-only", () => {
    const frag = render("# <script>x</script>\n- <img src=x>\n**<svg>**");
    const tags = elements(frag).map(e => e.tagName);
    assert.ok(!tags.includes("SCRIPT") && !tags.includes("IMG") && !tags.includes("SVG"));
    assert.ok(byTag(frag, "h1")[0].textContent === "<script>x</script>");
    assert.ok(byTag(frag, "li")[0].textContent === "<img src=x>");
    assert.ok(byTag(frag, "strong")[0].textContent === "<svg>");
});

test("rt12. streaming safety: every prefix of a complex doc renders without throwing", () => {
    const doc = "# Head\nText **bold** `c` [l](https://x.io)\n```sql\nSELECT 1\n```\n- a\n1. b\n> q";
    for (let n = 0; n <= doc.length; n++) {
        assert.doesNotThrow(() => render(doc.slice(0, n)), `prefix length ${n}`);
    }
});

// ---------- codebase XSS posture ----------

test("rt13. no HTML-parsing APIs anywhere in visual/src (repo XSS posture)", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "visual", "src");
    const banned = ["innerHTML", "outerHTML", "insertAdjacentHTML", "DOMParser"];
    for (const f of readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
        const text = readFileSync(join(srcDir, f), "utf8");
        // Strip comments so documentation MAY name the banned APIs.
        const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        for (const b of banned) {
            assert.ok(!codeOnly.includes(b), `${f} must not use ${b}`);
        }
    }
});
