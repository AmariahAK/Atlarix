/**
 * Syntax colours for an edit's diff lines. The lines keep their own layout
 * (numbers, +/−, backgrounds, ⋯ gaps); highlighting only recolours the text,
 * once the language's grammar answers (grammars.ts), so nothing moves.
 */
import { getTreeSitterClient, pathToFiletype, type SimpleHighlight } from "@opentui/core";
import { useEffect, useState } from "react";
import { useGrammar } from "./grammars";
import { codeColor } from "./theme";

export interface Segment {
  text: string;
  fg?: string;
  italic?: boolean;
}

/**
 * Split each line into coloured segments from highlights over `lines.join("\n")`.
 * A more specific capture ("function.method") wins over a broader one.
 */
export function segmentLines(lines: string[], highlights: SimpleHighlight[]): Segment[][] {
  const joined = lines.join("\n");
  const paint: Array<{ fg?: string; italic?: boolean } | undefined> = new Array(joined.length);
  const ordered = [...highlights].sort((a, b) => a[2].split(".").length - b[2].split(".").length);
  for (const [start, end, group] of ordered) {
    const c = codeColor(group);
    if (!c) continue;
    for (let i = Math.max(0, start); i < Math.min(end, joined.length); i++) paint[i] = c;
  }
  const out: Segment[][] = [];
  let at = 0;
  for (const line of lines) {
    const segs: Segment[] = [];
    for (let i = 0; i < line.length; i++) {
      const c = paint[at + i];
      const last = segs.at(-1);
      if (last && last.fg === c?.fg && last.italic === c?.italic) last.text += line[i];
      else segs.push({ text: line[i]!, fg: c?.fg, italic: c?.italic });
    }
    out.push(segs);
    at += line.length + 1;
  }
  return out;
}

/** The diff's lines as coloured segments once highlighted; null while plain (no grammar, or not back yet). */
export function useDiffSegments(path: string | undefined, lines: string[]): Segment[][] | null {
  const filetype = useGrammar(path ? pathToFiletype(path) : undefined);
  const key = lines.join("\n");
  const [segs, setSegs] = useState<{ key: string; segs: Segment[][] } | null>(null);
  useEffect(() => {
    if (!filetype) return;
    let live = true;
    void getTreeSitterClient()
      .highlightOnce(key, filetype)
      .then((r) => {
        if (live && r.highlights?.length) setSegs({ key, segs: segmentLines(lines, r.highlights) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // `lines` is captured through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filetype, key]);
  return segs && segs.key === key ? segs.segs : null;
}
