/**
 * Pure logic for the CLI bottom dock (the strip above the prompt box).
 * Extracted from App.tsx so it can be unit-tested without the TUI renderer.
 */
import type { LiveTask } from "../agent/session";

/** A row under the prompt box: one per sub-agent; every background command shares one. */
export type StripRow =
  | { kind: "agent"; task: LiveTask }
  | { kind: "commands"; tasks: LiveTask[]; stalled: boolean };

export function stripRows(tasks: LiveTask[]): StripRow[] {
  const rows: StripRow[] = tasks
    .filter((t) => t.kind === "agent")
    .map((task) => ({ kind: "agent", task }));
  const commands = tasks.filter((t) => t.kind === "command");
  if (commands.length) {
    rows.push({
      kind: "commands",
      tasks: commands,
      stalled: commands.some((c) => c.stalled),
    });
  }
  return rows;
}

/**
 * The label for the commands row in the dock.
 *
 * 0z: when any background command is stalled (gone quiet for 3+ min), the row
 * reads as "supervising" — a long-running service, not a stuck command. When
 * none are stalled, show the count as before.
 */
export function commandRowLabel(commands: LiveTask[]): string {
  if (commands.some((c) => c.stalled)) return "supervising";
  const n = commands.length;
  return `${n} command${n === 1 ? "" : "s"}`;
}
