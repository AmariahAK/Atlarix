/**
 * A finished command's output is readable without any UI having been open.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent terminal buffer used to be filled by the RENDERER: `TerminalPanel`
 * listened for `terminal-output`, built the lines, and pushed them down to main
 * through `terminal-instances:sync-scope`. Main created every instance with
 * `lines: []` and never wrote to them itself.
 *
 * `TerminalPanel` only mounts while the Terminal tab is SELECTED, so for anyone
 * who had not opened that tab, `background_jobs({operation:"read"})` returned an
 * empty buffer — the agent asked what its dev server had printed and was told
 * nothing had. The output existed; nobody kept it.
 *
 * Main now records at the moment it emits, which is also what let the agent tabs
 * be deleted from the panel without taking the read path with them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp/atlarix-agent-output-test" },
}));
vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => "/tmp/atlarix-agent-output-test",
}));

import {
  openTerminalInstance,
  appendAgentCommandOutput,
  readTerminalInstance,
  listTerminalInstances,
  clearAllTerminalScopes,
} from "@/lib/terminal-instance-store";

const SCOPE = "chat:4242";

beforeEach(() => {
  clearAllTerminalScopes();
});

describe("agent command output is buffered in main", () => {
  it("is readable after a command finishes, with no renderer involved", () => {
    const opened = openTerminalInstance(SCOPE, {
      owner: "agent",
      operationId: "op-1",
      commandHint: "npm run dev",
      background: true,
    });
    expect(opened.success).toBe(true);

    appendAgentCommandOutput(SCOPE, {
      operationId: "op-1",
      command: "npm run dev",
      output: "listening on :3000",
      status: "running",
    });
    appendAgentCommandOutput(SCOPE, {
      operationId: "op-1",
      command: "npm run dev",
      output: "listening on :3000\ncompiled ok",
      status: "completed",
    });

    const read = readTerminalInstance(SCOPE, opened.instanceId!);
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.text).toContain("npm run dev");
    expect(read.text).toContain("compiled ok");
    expect(read.text).toContain("exit 0");
  });

  it("replaces a re-emitted chunk instead of duplicating it", () => {
    // Output ids are keyed on accumulated length, so streaming updates for the
    // same command supersede each other rather than stacking.
    const opened = openTerminalInstance(SCOPE, {
      owner: "agent",
      operationId: "op-2",
      commandHint: "pytest",
      background: false,
    });
    for (const out of ["aa", "aabb", "aabbcc"]) {
      appendAgentCommandOutput(SCOPE, {
        operationId: "op-2",
        command: "pytest",
        output: out,
        status: "running",
      });
    }
    const read = readTerminalInstance(SCOPE, opened.instanceId!);
    if (!read.success) throw new Error("expected a readable instance");
    expect(read.text).toContain("aabbcc");
    expect(read.text).not.toContain("aa\n");
  });

  it("records a failure as failed, so a red run is inspectable", () => {
    const opened = openTerminalInstance(SCOPE, {
      owner: "agent",
      operationId: "op-3",
      commandHint: "false",
      background: false,
    });
    appendAgentCommandOutput(SCOPE, {
      operationId: "op-3",
      command: "false",
      output: "boom",
      status: "error",
    });
    const read = readTerminalInstance(SCOPE, opened.instanceId!);
    if (!read.success) throw new Error("expected a readable instance");
    expect(read.text).toContain("failed");
  });

  it("ignores output for an operation with no instance rather than throwing", () => {
    expect(() =>
      appendAgentCommandOutput(SCOPE, {
        operationId: "never-opened",
        command: "ls",
        output: "x",
        status: "completed",
      }),
    ).not.toThrow();
    expect(listTerminalInstances(SCOPE)).toHaveLength(0);
  });
});
