import type { TerminalInstance } from "@/atoms/terminalInstancesAtoms";

/**
 * Reserved `agentOpMap` key pointing at the ONE terminal that foreground agent
 * commands share.
 *
 * Shared between the renderer (which pre-creates the tab so it is visible before
 * the first command) and the main process (which decides where each command's
 * output goes). It previously lived only in TerminalPanel.tsx, so main had no way
 * to honour it — and main therefore created a fresh instance per command,
 * producing one tab per command on top of the renderer's shared one.
 */
export const AGENT_FG_KEY = "__agent_fg__";

/** Label for that shared tab — it is a session, not a single command. */
export const AGENT_FG_LABEL = "Agent";

export function defaultUserInstanceLabel(
  instances: TerminalInstance[],
): string {
  const n = instances.filter((i) => i.owner === "user").length + 1;
  return `Shell ${n}`;
}

export function defaultAgentInstanceLabel(
  command: string,
  instances: TerminalInstance[],
): string {
  const n = instances.filter((i) => i.owner === "agent").length + 1;
  const short = command.trim().slice(0, 28);
  return short ? `Agent ${n}: ${short}` : `Agent ${n}`;
}

export function shortenTerminalPath(fullPath: string): string {
  const m = fullPath.match(/^\/Users\/[^/]+(.*)$/);
  if (m) return `~${m[1] || ""}`;
  const win = fullPath.match(/^[A-Za-z]:\\Users\\[^\\]+(.*)$/);
  if (win) return `~${win[1].replace(/\\/g, "/") || ""}`;
  return fullPath;
}

/** Tab label for user-owned terminals (cwd or last command). */
export function userTabLabelFromInstance(
  inst: TerminalInstance,
  cwd?: string,
): string {
  const lastPrompt = [...inst.lines]
    .reverse()
    .find((l) => l.kind === "prompt" && l.prefix === "[You]");
  if (lastPrompt) {
    const cmd = lastPrompt.text.replace(/^\$\s*/, "").trim();
    if (cmd) {
      return cmd.length > 28 ? `${cmd.slice(0, 25)}…` : cmd;
    }
  }
  if (cwd) {
    const short = shortenTerminalPath(cwd);
    const base = short.split("/").filter(Boolean).pop();
    return base ? `~/${base}` : short || "Shell";
  }
  return inst.label;
}

/*
 * `agentTabStripLabel` lived here — it rendered the "A" / "A2" chips for agent
 * tabs in the strip. The agent has no tabs in the UI as of v14.27.0, so the
 * label has nothing to label. Agent instances still exist in MAIN, where they
 * buffer command output for `background_jobs`; they are simply never rendered.
 */
