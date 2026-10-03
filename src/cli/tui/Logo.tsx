/** @jsxImportSource @opentui/react */
/**
 * The welcome mark: the ◆ and "atlarix" in half-block letters, drawn here
 * rather than with a stock font so it is Atlarix's own (and the same in every
 * terminal). "atl" in grey, "arix" in white, like the wordmark's weight shift.
 */
import { color } from "./theme";

/** Three rows per letter, three columns wide. */
const GLYPHS: Record<string, [string, string, string]> = {
  a: ["▄▀▄", "█▀█", "▀ ▀"],
  t: ["▀█▀", " █ ", " ▀ "],
  l: ["█  ", "█  ", "▀▀▀"],
  r: ["█▀▄", "█▀▄", "▀ ▀"],
  i: ["▀█▀", " █ ", "▀▀▀"],
  x: ["▀▄▀", "▄▀▄", "▀ ▀"],
};

export function logoRows(word = "atlarix"): string[] {
  return [0, 1, 2].map((row) => [...word].map((ch) => GLYPHS[ch]?.[row] ?? "   ").join(" "));
}

export function Logo() {
  const rows = logoRows();
  // The first three letters, and the space after them, in grey.
  const split = 3 * 4;
  return (
    <box flexDirection="column" alignItems="center">
      {rows.map((r, i) => (
        <text key={i}>
          <span fg={color.accent}>{i === 1 ? "◆  " : "   "}</span>
          <span fg={color.muted}>{r.slice(0, split)}</span>
          <span fg={color.white}>{r.slice(split)}</span>
        </text>
      ))}
    </box>
  );
}
