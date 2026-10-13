/** @jsxImportSource @opentui/react */
/**
 * Atlarix's prose: markdown drawn synchronously, from marked's tokens.
 *
 * WHY NOT opentui's <markdown>. It draws paragraphs and headings with a code
 * renderable that hides the markdown syntax (`##`, `**`, backticks) only when an
 * async tree-sitter worker answers. Until then the raw text shows, so a reply
 * flickered between formatted text and `### …` / `---` while it streamed, and a
 * block's height could be measured on one version and drawn with the other: the
 * tail of a wrapped line was drawn over by the next block, which read as text
 * cut off (owner's wisdom-drop session, 2026-10-04). Here every block is plain
 * styled text the moment it exists; only fenced code is highlighted, and that
 * changes colours, never layout.
 *
 * Pure layout over `marked`'s lexer, so the headless tests render it too
 * (`plain` draws fenced code as text: tree-sitter runs in a worker that `bun
 * test` cannot host).
 */
import { lexer, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import { useGrammar } from "./grammars";
import { prepareMarkdown, settleStreaming } from "./markdown-prep";
import { infoStringToFiletype } from "@opentui/core";
import { color, syntax } from "./theme";

/** ```ts, ```py, ```shell…: the short tags people write, as the grammar names. */
export function fenceFiletype(lang: string | undefined): string | undefined {
  const tag = lang?.trim().split(/\s/)[0];
  return tag ? (infoStringToFiletype(tag) ?? tag) : undefined;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/** Display width: wide glyphs count two. */
export function displayWidth(s: string): number {
  const bun = (globalThis as { Bun?: { stringWidth?: (s: string) => number } }).Bun;
  return bun?.stringWidth ? bun.stringWidth(s) : s.length;
}

/** The tokens a reply renders as: streaming text is settled first. */
export function proseTokens(text: string, streaming: boolean): Token[] {
  const md = prepareMarkdown(streaming ? settleStreaming(text) : text);
  return lexer(md, { gfm: true }).filter((t) => t.type !== "space");
}

/**
 * marked puts a task item's `[x]` in its own `checkbox` token. The list draws
 * the box itself (☑/☐), so the token is dropped: drawn, it read "☑ [x]" with the
 * item's text on the next line (owner's plan card, 2026-10-05).
 */
const notCheckbox = (t: Token) => t.type !== "checkbox";

/** Inline markdown as plain text (table cells measure and wrap this). */
export function inlineText(tokens: Token[] | undefined, fallback = ""): string {
  if (!tokens) return unescape(fallback);
  return tokens
    .filter(notCheckbox)
    .map((t) => {
      const tok = t as Token & { tokens?: Token[]; text?: string };
      if (tok.type === "br") return " ";
      if (tok.type === "image") return `[image: ${(tok as Tokens.Image).text}]`;
      if (tok.tokens?.length) return inlineText(tok.tokens);
      return unescape(tok.text ?? tok.raw ?? "");
    })
    .join("");
}

function Inline({ tokens, fallback = "" }: { tokens?: Token[]; fallback?: string }): ReactNode {
  if (!tokens) return unescape(fallback);
  return tokens.filter(notCheckbox).map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <b key={i}>
            <span fg={color.white}>
              <Inline tokens={(t as Tokens.Strong).tokens} />
            </span>
          </b>
        );
      case "em":
        return (
          <i key={i}>
            <Inline tokens={(t as Tokens.Em).tokens} />
          </i>
        );
      case "del":
        return (
          <span key={i} fg={color.muted}>
            <Inline tokens={(t as Tokens.Del).tokens} />
          </span>
        );
      case "codespan":
        return (
          <span key={i} fg={color.code}>
            {unescape((t as Tokens.Codespan).text)}
          </span>
        );
      case "link": {
        const l = t as Tokens.Link;
        const label = inlineText(l.tokens, l.text);
        return (
          <span key={i} fg={color.accent}>
            {label}
            {l.href && l.href !== label && !l.href.startsWith("#") ? <span fg={color.muted}>{` (${l.href})`}</span> : null}
          </span>
        );
      }
      case "image":
        return (
          <span key={i} fg={color.muted}>
            {`[image: ${(t as Tokens.Image).text}]`}
          </span>
        );
      case "br":
        return "\n";
      default: {
        const tok = t as Token & { tokens?: Token[]; text?: string };
        if (tok.tokens?.length) return <Inline key={i} tokens={tok.tokens} />;
        return unescape(tok.text ?? tok.raw ?? "");
      }
    }
  });
}

/** Word-wrap to `w` columns (long words split). */
function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (displayWidth(rest) > w) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      const next = line ? `${line} ${rest}` : rest;
      if (displayWidth(next) > w) {
        out.push(line);
        line = rest;
      } else line = next;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - displayWidth(s)));

/** A grid table that fits `width`: columns shrink and cells wrap. */
export function tableLines(table: Tokens.Table, width: number): { lines: string[]; headerRows: number } {
  const header = table.header.map((c) => inlineText(c.tokens, c.text));
  const rows = table.rows.map((r) => r.map((c) => inlineText(c.tokens, c.text)));
  const n = header.length;
  const natural = Array.from({ length: n }, (_, j) =>
    Math.max(3, displayWidth(header[j] ?? ""), ...rows.map((r) => displayWidth(r[j] ?? ""))),
  );
  const budget = Math.max(n * 4, width - (3 * n + 1));
  const widths = [...natural];
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const k = widths.indexOf(Math.max(...widths));
    if (widths[k]! <= 4) break;
    widths[k]! -= 1;
  }
  const rule = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (cells: string[]) => {
    const wrapped = widths.map((w, j) => wrap(cells[j] ?? "", w));
    const h = Math.max(...wrapped.map((c) => c.length));
    return Array.from({ length: h }, (_, k) => `│ ${wrapped.map((c, j) => pad(c[k] ?? "", widths[j]!)).join(" │ ")} │`);
  };
  const head = row(header);
  const lines = [rule("┌", "┬", "┐"), ...head, rule("├", "┼", "┤")];
  rows.forEach((r, i) => {
    lines.push(...row(r));
    if (i < rows.length - 1) lines.push(rule("├", "┼", "┤"));
  });
  lines.push(rule("└", "┴", "┘"));
  return { lines, headerRows: head.length };
}

function Block({ token, width, plain, first }: { token: Token; width: number; plain: boolean; first: boolean }): ReactNode {
  const marginTop = first ? 0 : 1;
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      return (
        <text marginTop={marginTop} fg={color.heading}>
          <b>
            <Inline tokens={h.tokens} fallback={h.text} />
          </b>
        </text>
      );
    }
    case "paragraph":
    case "text": {
      const p = token as Tokens.Paragraph;
      return (
        <text marginTop={marginTop} fg={color.text}>
          <Inline tokens={p.tokens} fallback={p.text} />
        </text>
      );
    }
    case "list":
      return (
        <box marginTop={marginTop} flexDirection="column">
          <List list={token as Tokens.List} width={width} plain={plain} />
        </box>
      );
    case "blockquote":
      return (
        <box marginTop={marginTop} border={["left"]} borderColor={color.faint} paddingLeft={1} flexDirection="column">
          <Blocks tokens={(token as Tokens.Blockquote).tokens} width={Math.max(10, width - 2)} plain={plain} />
        </box>
      );
    case "code":
      return <CodeBlock token={token as Tokens.Code} marginTop={marginTop} plain={plain} />;
    case "hr":
      return <text marginTop={marginTop} fg={color.faint}>{"─".repeat(Math.max(3, Math.min(width, 80)))}</text>;
    case "table": {
      const { lines, headerRows } = tableLines(token as Tokens.Table, width);
      return (
        <box marginTop={marginTop} flexDirection="column">
          {lines.map((l, i) => (
            <text key={i} fg={i >= 1 && i <= headerRows ? color.white : color.textDim}>
              {l}
            </text>
          ))}
        </box>
      );
    }
    default:
      return (
        <text marginTop={marginTop} fg={color.textDim}>
          {unescape((token as { raw?: string }).raw?.trimEnd() ?? "")}
        </text>
      );
  }
}

/** Fenced code: highlighted once its language's grammar is ready (grammars.ts), plain text until then. */
function CodeBlock({ token, marginTop, plain }: { token: Tokens.Code; marginTop: number; plain: boolean }) {
  const filetype = useGrammar(plain ? undefined : fenceFiletype(token.lang));
  return (
    <box marginTop={marginTop} backgroundColor={color.panel} paddingLeft={1} paddingRight={1}>
      {plain ? (
        <text fg={color.text}>{token.text}</text>
      ) : (
        // conceal off: the JSON grammar conceals its quotes, so copied JSON came out invalid (QA #42).
        <code content={token.text} filetype={filetype} syntaxStyle={syntax} fg={color.text} conceal={false} />
      )}
    </box>
  );
}

function List({ list, width, plain }: { list: Tokens.List; width: number; plain: boolean }) {
  const start = typeof list.start === "number" ? list.start : 1;
  const markers = list.items.map((it, i) =>
    it.task ? (it.checked ? "☑" : "☐") : list.ordered ? `${start + i}.` : "–",
  );
  const markerWidth = Math.max(...markers.map(displayWidth));
  return (
    <>
      {list.items.map((item, i) => (
        <box key={i} flexDirection="row" marginTop={!list.loose || i === 0 ? 0 : 1}>
          <text fg={color.muted} flexShrink={0}>{`${pad(markers[i]!, markerWidth)} `}</text>
          <box flexGrow={1} flexDirection="column">
            <Blocks tokens={item.tokens.filter((t) => t.type !== "space" && notCheckbox(t))} width={Math.max(10, width - markerWidth - 1)} plain={plain} tight />
          </box>
        </box>
      ))}
    </>
  );
}

function Blocks({ tokens, width, plain, tight }: { tokens: Token[]; width: number; plain: boolean; tight?: boolean }) {
  return (
    <>
      {tokens.map((t, i) => (
        <Block key={i} token={t} width={width} plain={plain} first={i === 0 || (tight === true && t.type !== "code")} />
      ))}
    </>
  );
}

/** A reply's markdown. `width` is the columns the prose has (tables fit it). */
export function Prose({ text, streaming = false, width, plain = false }: { text: string; streaming?: boolean; width: number; plain?: boolean }) {
  const tokens = proseTokens(text, streaming);
  return (
    <box flexDirection="column">
      <Blocks tokens={tokens} width={width} plain={plain} />
    </box>
  );
}
