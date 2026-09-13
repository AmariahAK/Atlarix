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
 * What IS handled, because a chat answer uses these constantly: fenced code
 * blocks, bullet lists, inline code, bold, and bare URLs.
 */

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

    // ── Bullets ─────────────────────────────────────────────────────────────
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ""));
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
      !/^\s*[-*]\s+/.test(lines[i])
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
 */
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index;
    if (at > last) parent.append(text.slice(last, at));

    const [whole, code, bold, url] = match;
    if (code) {
      const el = document.createElement("code");
      el.textContent = code.slice(1, -1);
      parent.append(el);
    } else if (bold) {
      const el = document.createElement("strong");
      el.textContent = bold.slice(2, -2);
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
