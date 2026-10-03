/**
 * `!command` in the prompt box: the user runs a command themselves, in this
 * folder, without asking the agent (Codex's and Claude Code's `!`). It is the
 * user's own command, so it runs like their terminal would — no approval, no
 * sandbox — and Esc stops it.
 *
 * The agent sees what was run: the commands and their output since the last
 * message ride along with the NEXT message (the transcript still shows only
 * what the user typed), so "!npm test" then "fix that" works.
 */
import type { Cell, ToolLine } from "./transcript";

export interface ShellRun {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  status: ToolLine["status"];
  /** The message this run came after ("" before the first), to place it in the transcript. */
  afterMessageId: string;
  /** Already given to the agent with a message. */
  delivered: boolean;
}

/** What the agent is given per run: the end of the output, which is where the errors are. */
const CONTEXT_CHARS = 16_000;

/** `!ls -la` → `ls -la`; anything else (or a bare `!`) → null. */
export function parseShellInput(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("!")) return null;
  const command = t.slice(1).trim();
  return command || null;
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf("\n");
  return `[… ${text.length - max} earlier characters cut]\n${nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut}`;
}

/** The prompt the agent receives: the user's shell runs first, then what they typed. */
export function withShellContext(prompt: string, runs: readonly ShellRun[]): string {
  const fresh = runs.filter((r) => !r.delivered && r.status !== "running");
  if (fresh.length === 0) return prompt;
  const blocks = fresh.map((r) => {
    const how =
      r.status === "interrupted" ? "stopped by the user" : r.exitCode == null ? "exit code unknown" : `exit code ${r.exitCode}`;
    return [
      `<user_shell_command>`,
      `$ ${r.command}`,
      `(${how})`,
      tail(r.output.replace(/\s+$/, ""), CONTEXT_CHARS) || "(no output)",
      `</user_shell_command>`,
    ].join("\n");
  });
  return `The user ran ${fresh.length === 1 ? "this command" : "these commands"} in their terminal, in the workspace:\n\n${blocks.join("\n\n")}\n\n${prompt}`;
}

export function shellCell(run: ShellRun): Cell {
  const lines = run.output.replace(/\s+$/, "").split("\n");
  const last = lines.filter((l) => l.trim()).at(-1) ?? "";
  const summary =
    run.status === "running"
      ? last || "running…"
      : run.status === "interrupted"
        ? "stopped"
        : run.exitCode && run.exitCode !== 0
          ? `exit ${run.exitCode}${last ? ` · ${last}` : ""}`
          : last || "done, no output";
  return {
    kind: "tool",
    id: `shell:${run.id}`,
    tool: {
      id: run.id,
      verb: "!",
      target: run.command,
      status: run.status === "success" && run.exitCode && run.exitCode !== 0 ? "error" : run.status,
      output: run.output,
      summary,
    },
  };
}

/**
 * Put each run after the cells of the message it followed (cell ids start with
 * the message id), or at the top when it came before any message.
 */
export function placeShellRuns(cells: Cell[], runs: readonly ShellRun[]): Cell[] {
  if (runs.length === 0) return cells;
  const out = [...cells];
  for (const run of runs) {
    let at = 0;
    if (run.afterMessageId) {
      const prefix = `${run.afterMessageId}:`;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i]!.id.startsWith(prefix)) {
          at = i + 1;
          break;
        }
      }
      if (at === 0) at = out.length;
    }
    // Several runs after one message keep their order.
    while (at < out.length && out[at]!.id.startsWith("shell:")) at++;
    out.splice(at, 0, shellCell(run));
  }
  return out;
}
