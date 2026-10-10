/**
 * Just enough Markdown for a chat panel, built entirely from DOM nodes.
 *
 * NOT `innerHTML`, ANYWHERE, AND NOT AS A STYLE PREFERENCE. What this renders
 * is model output, and model output in this product is downstream of web pages
 * the agent has read. A page that gets the model to echo an `<img
 * onerror=...>` back would be executing script in an EXTENSION page — the one
 * context that holds the user's Supabase session, their site grants and the
 * `chrome.*` namespace. Every node below is `createElement` plus
 * `textContent`, so there is no parse step that could be tricked, and the
 * panel's CSP (MV3 default, no `unsafe-inline`) is a second line rather than
 * the only one.
 *
 * NOT A MARKDOWN LIBRARY, AND NOT TRYING TO BE. A dependency here would be the
 * first one this package has — something a Web Store reviewer reads, and
 * something with its own release cadence — to render four constructs. Tables,
 * nested lists, blockquotes and images are deliberately absent: they render as
 * their literal text, which is legible, rather than as a half-supported
 * approximation that looks broken.
 *
 * What IS handled, because a chat answer uses these constantly: headings,
 * fenced code blocks, bullet and numbered lists, inline code, bold, and bare
 * URLs.
 *
 * HEADINGS AND NUMBERED LISTS WERE THE EXCEPTION TO "unhandled is legible".
 * That principle holds for a table or a blockquote, whose literal text still
 * reads as what it is. It did not hold here. A heading fell through to the
 * paragraph branch, which joins consecutive lines with a space — so `### Main
 * message` and the sentence under it became one line beginning with three hash
 * marks, and a numbered list collapsed into a single paragraph with the numbers
 * still in it. Not a plainer rendering of the content: a wrong one.
 */

/**
 * A numbered list item: `1.` or `1)`, optionally indented.
 *
 * NOT GLOBAL — a `g` flag would make `.test` stateful across the two calls in
 * the loop below and skip every other line.
 */
const ORDERED = /^\s*(\d{1,9})[.)]\s+/;

/**
 * A table's separator row: `|---|:--:|` and friends.
 *
 * THIS is what makes a table a table. A header line alone is just a sentence
 * with pipes in it, and treating one as a table would eat ordinary prose.
 */
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head || !sep) return false;
  if (!head.includes("|")) return false;
  if (!TABLE_SEP.test(sep)) return false;
  // Both rows must agree on the column count, or it is not the table the model
  // meant and rendering it would invent structure that is not there.
  return splitRow(head).length === splitRow(sep).length;
}

/** Cells of one row, with the optional leading and trailing pipes dropped. */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * A checklist item (`[ ]`, `[x]`, `[~]` in progress) reads as a box, not as
 * bracket characters: plans are written this way and showed "[ ] Add …".
 */
function taskBox(text: string): string {
  return text.replace(/^\[( |x|X|~)\]\s+/, (_m, mark: string) =>
    mark === " " ? "☐ " : mark === "~" ? "◐ " : "☑ ",
  );
}

/** Render `markdown` into `container`, replacing whatever was there. */
export function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.textContent = "";
  for (const node of parseBlocks(markdown)) container.append(node);
}

function parseBlocks(markdown: string): Node[] {
  const out: Node[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code ─────────────────────────────────────────────────────────
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      // A fence the stream has not closed yet still renders as code. Waiting
      // for the closing ``` makes a long block appear as raw text and then
      // snap into place, which reads as a glitch.
      i += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (fence[1]) code.dataset.lang = fence[1];
      code.textContent = body.join("\n");
      pre.append(code);
      out.push(pre);
      continue;
    }

    // ── Tables ──────────────────────────────────────────────────────────────
    //
    // PROMOTED OUT OF "UNHANDLED IS LEGIBLE" on 2026-09-17, for the same reason
    // headings and numbered lists were. That rule holds for a blockquote, whose
    // raw text still reads as what it is. A table's raw text is a wall of pipes
    // and dashes: not a plainer rendering of the content, a wrong one. The
    // owner hit it the first time a model answered with a comparison.
    //
    // Requires the separator row, which is what distinguishes a real table from
    // a paragraph that happens to contain a pipe. Anything that does not match
    // falls through to the branches below unchanged.
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const rows: string[][] = [];
      i += 2; // the header and its ---|--- separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const t = document.createElement("table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const cell of head) {
        const th = document.createElement("th");
        appendInline(th, cell);
        hr.append(th);
      }
      thead.append(hr);
      t.append(thead);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        // Pad or trim to the header's width. A ragged row is common in streamed
        // output and must not shift the columns of every row after it.
        for (let c = 0; c < head.length; c += 1) {
          const td = document.createElement("td");
          appendInline(td, row[c] ?? "");
          tr.append(td);
        }
        tbody.append(tr);
      }
      t.append(tbody);
      // The panel is ~320px wide and a table is the one construct that cannot
      // reflow to fit. Scrolling it beats squeezing four columns into nothing.
      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      wrap.append(t);
      out.push(wrap);
      continue;
    }

    // ── Headings ────────────────────────────────────────────────────────────
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      // The real level, so `#` and `###` are distinguishable. They are sized
      // for a 320px column in the stylesheet rather than by the browser's
      // defaults, which would put an h1 at 32px inside a chat bubble.
      const h = document.createElement(`h${heading[1].length}`);
      appendInline(h, heading[2]);
      out.push(h);
      i += 1;
      continue;
    }

    // ── Numbered lists ──────────────────────────────────────────────────────
    if (ORDERED.test(line)) {
      const ol = document.createElement("ol");
      // A list that starts at 3 renders starting at 3. The model numbers its
      // own steps and a list silently renumbered from 1 contradicts the prose
      // around it, which refers to "step 4".
      const first = Number.parseInt(ORDERED.exec(line)?.[1] ?? "1", 10);
      if (first !== 1) ol.start = first;
      while (i < lines.length && ORDERED.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, taskBox(lines[i].replace(ORDERED, "")));
        ol.append(li);
        i += 1;
      }
      out.push(ol);
      continue;
    }

    // ── Bullets ─────────────────────────────────────────────────────────────
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, taskBox(lines[i].replace(/^\s*[-*]\s+/, "")));
        ul.append(li);
        i += 1;
      }
      out.push(ul);
      continue;
    }

    // ── Blank ───────────────────────────────────────────────────────────────
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // ── Paragraph ───────────────────────────────────────────────────────────
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !ORDERED.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    const p = document.createElement("p");
    appendInline(p, para.join(" "));
    out.push(p);
  }

  return out;
}

/**
 * Inline spans, in one pass.
 *
 * ONE REGEX WITH ALTERNATION rather than successive replaces, because the
 * alternatives must not apply to each other's output: a URL inside a code span
 * is not a link, and `**` inside a URL is not bold. Scanning left to right and
 * consuming whole matches is what makes that true without any escaping.
 *
 * ORDER IS LOAD-BEARING between bold and italic. Alternation is tried left to
 * right, so `**x**` must be offered the bold branch before the italic one or it
 * matches `*` + `*x*` and renders a stray asterisk around italic text.
 *
 * ITALIC IS `*x*` ONLY, never `_x_`. Underscores appear inside ordinary tokens
 * the model writes constantly — `read_attachment`, `file_data`, snake_case
 * anything — and a pair of them in one line would swallow the middle into
 * emphasis. Asterisks do not occur that way.
 */
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) parent.append(text.slice(last, at));

    const [whole, code, bold, italic, url] = match;
    if (code) {
      const el = document.createElement("code");
      el.textContent = code.slice(1, -1);
      parent.append(el);
    } else if (bold) {
      const el = document.createElement("strong");
      el.textContent = bold.slice(2, -2);
      parent.append(el);
    } else if (italic) {
      const el = document.createElement("em");
      el.textContent = italic.slice(1, -1);
      parent.append(el);
    } else if (url) {
      const el = document.createElement("a");
      el.href = url;
      el.textContent = url;
      el.target = "_blank";
      // `noopener` is the load-bearing half: without it the opened page gets a
      // `window.opener` handle back to an EXTENSION page. `noreferrer` is
      // ordinary hygiene.
      el.rel = "noopener noreferrer";
      parent.append(el);
    }
    last = at + whole.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
