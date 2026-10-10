/** @jsxImportSource @opentui/react */
/**
 * Rix in the terminal: the weaver ant as half-block pixels, three rows high.
 *
 * Each character cell carries two pixels — the top one as the foreground of
 * "▀", the bottom one as its background — so the globe keeps its meridian and
 * the head keeps an eye at this size. The SVG Rix (`@/lib/rix/rix-svg`) is the
 * same character; this is its terminal cut, not a copy of anyone's sprite.
 */
import { useEffect, useState } from "react";
import { color } from "./theme";

export type RixMood = "rest" | "working" | "found";

/** Pixel palette. "." is empty. */
const PALETTE: Record<string, string> = {
  G: color.accent, // globe, body
  D: "#047857", // globe meridians, far legs
  S: color.accentSoft, // head, needle tip
  K: color.bg, // the eye
  N: "#52525b", // needle tail
};

/**
 * Six pixel rows by fourteen columns, facing right: the globe at the back,
 * waist, thorax, head with its eye, the compass antenna above. The legs and the
 * needle are the parts that change between frames.
 */
const BODY = [
  "..............",
  ".GGG......SSS.",
  "GDGDG.GGG.SKS.",
  "GGDGGDGGGSSSSS",
  ".GGG..........",
  "..............",
];

const NEEDLE = {
  up: "..........NSS.",
  swung: ".........NNS..",
  locked: "...........SSS",
};

const LEGS = {
  a: ["......D.G.D...", ".....D..G..D.."],
  b: ["......G.D.G...", "......G.D.G..."],
};

/** The six pixel rows for one frame. */
export function rixPixels(mood: RixMood, tick: number): string[] {
  const needle = mood === "found" ? NEEDLE.locked : mood === "working" && tick % 2 ? NEEDLE.swung : NEEDLE.up;
  const legs = mood === "working" && tick % 2 ? LEGS.b : LEGS.a;
  const rows = BODY.slice();
  rows[0] = needle;
  rows[4] = merge(rows[4]!, legs[0]!);
  rows[5] = legs[1]!;
  return rows;
}

function merge(under: string, over: string): string {
  return [...under].map((ch, i) => (over[i] && over[i] !== "." ? over[i]! : ch)).join("");
}

export interface RixCell {
  ch: string;
  fg?: string;
  bg?: string;
}

/** Fold pixel rows in pairs into terminal cells. */
export function rixCells(pixels: string[]): RixCell[][] {
  const out: RixCell[][] = [];
  for (let r = 0; r < pixels.length; r += 2) {
    const top = pixels[r]!;
    const bottom = pixels[r + 1] ?? "";
    const row: RixCell[] = [];
    for (let c = 0; c < top.length; c++) {
      const t = PALETTE[top[c]!];
      const b = PALETTE[bottom[c] ?? "."];
      if (!t && !b) row.push({ ch: " " });
      else if (t && !b) row.push({ ch: "▀", fg: t });
      else if (!t && b) row.push({ ch: "▄", fg: b });
      else if (t === b) row.push({ ch: "█", fg: t });
      else row.push({ ch: "▀", fg: t, bg: b });
    }
    out.push(row);
  }
  return out;
}

/** Width in columns, for laying out what sits beside Rix. */
export const RIX_WIDTH = BODY[0]!.length;

/**
 * Rix, three rows. `mood="working"` walks at 4 frames a second; `animate`
 * false (an unfocused terminal) holds the frame, so an idle tab costs nothing.
 */
export function Rix({ mood = "rest", animate = true }: { mood?: RixMood; animate?: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mood !== "working" || !animate) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [mood, animate]);
  const rows = rixCells(rixPixels(mood, tick));
  return (
    <box flexDirection="column" flexShrink={0} width={RIX_WIDTH}>
      {rows.map((row, i) => (
        <text key={i}>
          {row.map((cell, j) => (
            <span key={j} fg={cell.fg} bg={cell.bg}>
              {cell.ch}
            </span>
          ))}
        </text>
      ))}
    </box>
  );
}
