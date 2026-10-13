/**
 * Small text rules for the CLI screen. Pure (src/__tests__/cli-format.test.ts).
 */
import os from "node:os";
import type { SessionState } from "../agent/session";

/** `~` for home, then cut from the middle so the folder's own name survives: `~/…/p2/ws`. */
export function abbreviatePath(p: string, max: number, home = os.homedir()): string {
  // Windows paths keep their own separator: "C:\Users\…\ws one", not a mix of
  // "\" and "/" with a stray "/…/" (QA, Windows VM).
  const sep = /^[A-Za-z]:\\|^\\\\/.test(p) || (p.includes("\\") && !p.includes("/")) ? "\\" : "/";
  let s = p === home || p.startsWith(home + sep) ? "~" + p.slice(home.length) : p;
  if (s.length <= max) return s;
  const parts = s.split(sep);
  const head = parts[0] === "" ? sep : parts[0] + sep;
  const tail: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    const next = [parts[i], ...tail].join(sep);
    if (head.length + 2 + next.length > max && tail.length > 0) break;
    tail.unshift(parts[i]!);
  }
  s = `${head}…${sep}${tail.join(sep)}`;
  return s.length <= max ? s : "…" + s.slice(s.length - max + 1);
}

const GERUND: Record<string, string> = {
  Read: "Reading",
  Search: "Searching",
  Find: "Finding files",
  Run: "Running",
  Edit: "Editing",
  "Web search": "Searching the web",
  Fetch: "Fetching",
  Agent: "Delegating",
  Agents: "Delegating",
  Browser: "Using the browser",
};

/** What the working line says: from what is happening, never internal phase names. */
export function activityLabel(state: Pick<SessionState, "cells" | "approvals" | "busy"> & { retrying?: string | null }): string | null {
  if (!state.busy) return null;
  if (state.approvals.length) return "Waiting for you";
  if (state.retrying) return state.retrying;
  const last = state.cells.at(-1);
  if (last?.kind === "tool" && last.tool.status === "running") {
    const verb = GERUND[last.tool.verb] ?? last.tool.verb;
    const target = last.tool.target.length > 40 ? last.tool.target.slice(0, 39) + "…" : last.tool.target;
    return target ? `${verb} ${target}…` : `${verb}…`;
  }
  if (last?.kind === "markdown") return "Writing…";
  return "Thinking…";
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** The first line, cut to `max` characters with "…" when anything was dropped. */
export function oneLine(text: string, max: number): string {
  const first = text.replace(/\s+$/, "").split("\n")[0] ?? "";
  const cut = first.length > max ? first.slice(0, Math.max(1, max - 1)).trimEnd() : first;
  const more = cut !== first || text.trim().includes("\n");
  return more ? `${cut}…` : cut;
}

/**
 * What a finished thought was about, in one line: its bold title when it has
 * one (models often open with `**Checking the routes**`), else its first
 * sentence. The editor panel draws the same summary (webview transcript.ts).
 */
export function thoughtSummary(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // Inline markdown out: "`ToolPart` — where…" reads as "ToolPart — where…".
  const plain = (s: string) => s.replace(/\*\*|__|`/g, "");
  const title = /^\*\*(.+?)\*\*:?$/.exec(lines[0] ?? "")?.[1];
  if (title) return plain(title);
  return firstSentenceOf(plain(lines[0] ?? ""));
}

/** Where a line's first sentence ends, not at "e.g." / "i.e." / "etc." (QA saw "Now a representative tool, e.g."). */
function firstSentenceOf(line: string): string {
  const end = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = end.exec(line)) !== null) {
    const upTo = line.slice(0, m.index + 1);
    if (/\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\.$/i.test(upTo) || /(?:^|\s)[A-Za-z]\.$/.test(upTo)) continue;
    return upTo;
  }
  return line;
}

