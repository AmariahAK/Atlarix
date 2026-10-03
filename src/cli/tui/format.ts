/**
 * Small text rules for the CLI screen. Pure (src/__tests__/cli-format.test.ts).
 */
import os from "node:os";
import type { SessionState } from "../agent/session";

/** `~` for home, then cut from the middle so the folder's own name survives: `~/…/p2/ws`. */
export function abbreviatePath(p: string, max: number, home = os.homedir()): string {
  let s = p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
  if (s.length <= max) return s;
  const parts = s.split("/");
  const head = parts[0] === "" ? "/" : parts[0] + "/";
  const tail: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    const next = [parts[i], ...tail].join("/");
    if (head.length + 2 + next.length > max && tail.length > 0) break;
    tail.unshift(parts[i]!);
  }
  s = `${head}…/${tail.join("/")}`;
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
export function activityLabel(state: Pick<SessionState, "cells" | "approvals" | "busy">): string | null {
  if (!state.busy) return null;
  if (state.approvals.length) return "Waiting for you";
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
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** The first line, cut to `max` characters with "…" when anything was dropped. */
export function oneLine(text: string, max: number): string {
  const first = text.replace(/\s+$/, "").split("\n")[0] ?? "";
  const cut = first.length > max ? first.slice(0, Math.max(1, max - 1)).trimEnd() : first;
  const more = cut !== first || text.trim().includes("\n");
  return more ? `${cut}…` : cut;
}
