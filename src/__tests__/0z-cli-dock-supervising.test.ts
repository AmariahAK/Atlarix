/**
 * 0z: CLI bottom dock — background tasks read as "stuck to the bottom".
 *
 * Long-running background commands (e.g. EC2 supervisors, 111 min) sit pinned
 * at the bottom looking frozen. Fix: stalled commands show "supervising" in the
 * dock row instead of the plain running glyph; completed jobs leave the dock.
 *
 * Tests:
 * 1. stripRows groups commands into one row; a stalled command is flagged.
 * 2. commandRowLabel returns "supervising" when any command is stalled.
 * 3. commandRowLabel returns the command count label when none are stalled.
 * 4. A completed job (not in liveTasks) leaves the dock (stripRows returns empty).
 */
import { describe, expect, it } from "vitest";
import { stripRows, commandRowLabel } from "@/cli/tui/dock-logic";
import type { LiveTask } from "@/cli/agent/session";

function makeCommand(id: string, elapsedMs: number, stalled: boolean): LiveTask {
  return {
    id: `cmd:${id}`,
    kind: "command",
    label: `$ ${id}`,
    elapsedMs,
    stalled,
    tools: [],
  };
}

describe("0z: CLI dock background task display", () => {
  it("stripRows groups commands into one row", () => {
    const tasks: LiveTask[] = [
      makeCommand("ec2-supervisor", 6_660_000, true), // 111 min, stalled
      makeCommand("log-tail", 120_000, false),
    ];
    const rows = stripRows(tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("commands");
    if (rows[0]!.kind === "commands") {
      expect(rows[0]!.tasks).toHaveLength(2);
    }
  });

  it("commandRowLabel returns 'supervising' when any command is stalled", () => {
    const tasks: LiveTask[] = [
      makeCommand("ec2-supervisor", 6_660_000, true), // stalled
      makeCommand("log-tail", 120_000, false),
    ];
    const label = commandRowLabel(tasks);
    expect(label).toBe("supervising");
  });

  it("commandRowLabel returns count label when no commands are stalled", () => {
    const tasks: LiveTask[] = [
      makeCommand("build", 30_000, false),
      makeCommand("test", 15_000, false),
    ];
    const label = commandRowLabel(tasks);
    expect(label).toBe("2 commands");
  });

  it("commandRowLabel returns singular for one non-stalled command", () => {
    const tasks: LiveTask[] = [makeCommand("build", 30_000, false)];
    const label = commandRowLabel(tasks);
    expect(label).toBe("1 command");
  });

  it("a completed job leaves the dock (stripRows returns empty for no tasks)", () => {
    // liveTasks() only returns running jobs; a completed job is absent.
    const rows = stripRows([]);
    expect(rows).toHaveLength(0);
  });

  it("a stalled command row has the stalled flag set", () => {
    const tasks: LiveTask[] = [makeCommand("ec2-supervisor", 6_660_000, true)];
    const rows = stripRows(tasks);
    expect(rows[0]!.kind).toBe("commands");
    if (rows[0]!.kind === "commands") {
      expect(rows[0]!.stalled).toBe(true);
    }
  });
});
