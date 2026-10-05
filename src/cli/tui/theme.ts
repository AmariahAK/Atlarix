/**
 * Atlarix in the terminal: green on near-black, as on the approved canvas
 * (https://claude.ai/artifact/PpPrQEqkx2En5uQioG4As7).
 */
import { SyntaxStyle } from "@opentui/core";

export const color = {
  bg: "#0a0a0a",
  panel: "#121212",
  /** Your messages' band: plainly lighter than the background in any terminal. */
  promptBg: "#26282c",
  addBg: "#0f2a1c",
  removeBg: "#2e1416",
  border: "#2a2a2a",
  accent: "#10b981",
  accentSoft: "#34d399",
  accentBg: "#0f2a20",
  text: "#e5e5e5",
  textDim: "#a3a3a3",
  muted: "#8a8a8a",
  faint: "#5c5c5c",
  warn: "#f5b454",
  warnBg: "#15130d",
  error: "#f28b82",
  errorBg: "#2a1517",
  white: "#ffffff",
  /** Inline code: lavender text, no chip. The dim grey chip got lost in long answers (owner, 2026-10-05). */
  code: "#c4b5fd",
  /** The prompt box: a step above the page, so it reads as the place to type. */
  raised: "#15171a",
} as const;

/** Code colours, around the emerald: strings green, keywords lavender, numbers amber. */
const code = {
  fn: "#7dd3fc",
  type: "#fde68a",
  tag: "#f9a8d4",
  member: "#d4d4d4",
} as const;

type Rule = { scope: string[]; style: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean } };

/** Code token colours: fenced code (via opentui) and diff lines (via `codeColor`) share them. */
const codeRules: Rule[] = [
  { scope: ["comment"], style: { foreground: color.muted, italic: true } },
  { scope: ["string"], style: { foreground: color.accentSoft } },
  { scope: ["keyword"], style: { foreground: color.code } },
  { scope: ["number", "boolean", "constant", "character"], style: { foreground: color.warn } },
  { scope: ["function", "constructor"], style: { foreground: code.fn } },
  { scope: ["type", "module", "label"], style: { foreground: code.type } },
  { scope: ["tag", "attribute"], style: { foreground: code.tag } },
  { scope: ["property", "variable.member", "variable.parameter"], style: { foreground: code.member } },
  { scope: ["variable.builtin", "constant.builtin"], style: { foreground: color.warn, italic: true } },
  { scope: ["operator", "punctuation"], style: { foreground: color.muted } },
  { scope: ["string.escape", "string.regexp", "string.special"], style: { foreground: color.accent } },
];

/** A tree-sitter capture's colour: the exact name, else its first segment ("function.method" → "function"). */
export function codeColor(group: string): { fg?: string; italic?: boolean } | undefined {
  const find = (name: string) => codeRules.find((r) => r.scope.includes(name))?.style;
  const st = find(group) ?? (group.includes(".") ? find(group.split(".")[0]!) : undefined);
  return st ? { fg: st.foreground, italic: st.italic } : undefined;
}

export const syntax = SyntaxStyle.fromTheme([
  { scope: ["default"], style: { foreground: color.text } },
  { scope: ["extmark.paste", "extmark.file", "extmark.image"], style: { foreground: color.accent, background: color.accentBg, bold: true } },
  // A /command and a shell "!" as you type them (Composer.tsx).
  { scope: ["prompt.command"], style: { foreground: color.accentSoft, bold: true } },
  { scope: ["prompt.shell"], style: { foreground: color.warn, bold: true } },
  // Green is the accent, not the text colour: it marks Atlarix (◆), links and
  // code strings. Headings, inline code and bullets in green made long answers
  // read as a wall of green (owner, 2026-10-03), so headings are bold white.
  {
    scope: ["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
    style: { foreground: color.white, bold: true },
  },
  { scope: ["markup.bold", "markup.strong"], style: { foreground: color.white, bold: true } },
  { scope: ["markup.italic"], style: { italic: true } },
  { scope: ["markup.list"], style: { foreground: color.muted } },
  { scope: ["markup.quote"], style: { foreground: color.textDim, italic: true } },
  { scope: ["markup.raw", "markup.raw.inline"], style: { foreground: color.code } },
  // Fenced code reads as a block: its own background, like the other CLIs.
  { scope: ["markup.raw.block"], style: { foreground: color.text, background: color.panel } },
  { scope: ["markup.link", "markup.link.label"], style: { foreground: color.accent, underline: true } },
  { scope: ["markup.link.url"], style: { foreground: color.muted } },
  ...codeRules,
]);


export { glyph } from "./glyphs";
