/**
 * Atlarix in the terminal: green on a green-black base (owner's palette,
 * 2026-10-13). Green marks Atlarix, the prompt and success; sand marks
 * headings; sky marks code, paths and branches; amber is for warnings only.
 */
import { SyntaxStyle } from "@opentui/core";

export const color = {
  /** Base: the full-screen background. */
  bg: "#0a0e0d",
  panel: "#111715",
  /** Your messages' band: plainly lighter than the background in any terminal. */
  promptBg: "#1c2622",
  addBg: "#163024",
  removeBg: "#2a1618",
  border: "#35413b",
  accent: "#3ddc97",
  accentSoft: "#7ee6b8",
  accentBg: "#12271e",
  /** Body: normal text. */
  text: "#cfe8dd",
  textDim: "#a3bbb0",
  /** Meta, bullets, hints. */
  muted: "#7c948a",
  faint: "#5b6e66",
  /** Amber: warnings only. */
  warn: "#e3b65f",
  warnBg: "#1a170e",
  error: "#f07c7c",
  errorBg: "#2a1618",
  /** Bright: bold text, numbers, names. */
  white: "#e8f5ee",
  /** Sand: section headings. */
  heading: "#f2e8d5",
  /** Sky: inline code, paths and branches. */
  code: "#7dbbe8",
  /** The prompt box: a step above the page, so it reads as the place to type. */
  raised: "#141b18",
} as const;

/** Code colours from the same palette: strings green, keywords sky, types and numbers sand. */
const code = {
  fn: color.white,
  type: color.heading,
  tag: color.code,
  member: color.text,
} as const;

type Rule = { scope: string[]; style: { foreground?: string; background?: string; bold?: boolean; italic?: boolean; underline?: boolean } };

/** Code token colours: fenced code (via opentui) and diff lines (via `codeColor`) share them. */
const codeRules: Rule[] = [
  { scope: ["comment"], style: { foreground: color.muted, italic: true } },
  { scope: ["string"], style: { foreground: color.accentSoft } },
  { scope: ["keyword"], style: { foreground: color.code } },
  { scope: ["number", "boolean", "constant", "character"], style: { foreground: color.heading } },
  { scope: ["function", "constructor"], style: { foreground: code.fn } },
  { scope: ["type", "module", "label"], style: { foreground: code.type } },
  { scope: ["tag", "attribute"], style: { foreground: code.tag } },
  { scope: ["property", "variable.member", "variable.parameter"], style: { foreground: code.member } },
  { scope: ["variable.builtin", "constant.builtin"], style: { foreground: color.heading, italic: true } },
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
  { scope: ["prompt.shell"], style: { foreground: color.code, bold: true } },
  // Green is the accent, not the text colour: it marks Atlarix (◆), links and
  // code strings. Headings, inline code and bullets in green made long answers
  // read as a wall of green (owner, 2026-10-03), so headings are bold sand.
  {
    scope: ["markup.heading", "markup.heading.1", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"],
    style: { foreground: color.heading, bold: true },
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
