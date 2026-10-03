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
} as const;

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
  // Inline code: the text colour on a panel background, like a code chip.
  { scope: ["markup.raw", "markup.raw.inline"], style: { foreground: color.text, background: color.promptBg } },
  // Fenced code reads as a block: its own background, like the other CLIs.
  { scope: ["markup.raw.block"], style: { foreground: color.text, background: color.panel } },
  { scope: ["markup.link", "markup.link.label"], style: { foreground: color.accent, underline: true } },
  { scope: ["markup.link.url"], style: { foreground: color.muted } },
  { scope: ["comment"], style: { foreground: color.muted, italic: true } },
  { scope: ["string"], style: { foreground: color.accentSoft } },
  { scope: ["keyword"], style: { foreground: color.warn } },
  { scope: ["number", "boolean"], style: { foreground: color.warn } },
]);


export { glyph } from "./glyphs";
