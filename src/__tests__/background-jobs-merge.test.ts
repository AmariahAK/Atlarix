/**
 * `background_jobs` absorbed `terminal_read` / `terminal_list`.
 *
 * Those two shipped in v14.19.0 and were never released. Reviewing them showed
 * most of what they offered already existed here — three tools competing to
 * report on the agent's own work is worse than one that reports on all of it.
 * What was genuinely missing, and is tested below:
 *
 *   - addressing a job by a NAME the model chose, not just a generated id
 *   - a tail read, for "what does this look like NOW" rather than "what changed"
 *   - reading a finished job whose result was already delivered
 *
 * That last one matters beyond convenience: refusing it is what let a model
 * conclude it had missed the output and re-run work that had already succeeded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => "/tmp/atlarix-bgjobs-merge-test",
}));

import {
  listTerminalInstances,
  openTerminalInstance,
  readTerminalInstance,
  resolveScopeKey,
  setTerminalScopeState,
  appendAgentCommandOutput,
} from "@/lib/terminal-instance-store";
import { AGENT_FG_LABEL } from "@/lib/terminal-instances";

/**
 * The finished-job fallback resolves a tab the same way the tool does: id,
 * then exact label, then substring. Mirrored here because the tool's handler
 * needs a live chat session to invoke directly.
 */
function resolveTab(scopeKey: string, wanted: string) {
  const tabs = listTerminalInstances(scopeKey);
  const needle = wanted.toLowerCase();
  return (
    tabs.find((t) => t.id === wanted) ??
    tabs.find((t) => t.label.toLowerCase() === needle) ??
    tabs.find((t) => t.label.toLowerCase().includes(needle)) ??
    null
  );
}

let seq = 500;
function freshScope(): string {
  seq += 1;
  const key = resolveScopeKey(-seq, null);
  setTerminalScopeState(key, {
    instances: [],
    activeInstanceId: null,
    agentOpMap: {},
  });
  return key;
}

describe("finished-job output falls back to the terminal tab", () => {
  beforeEach(() => {
    seq += 10;
  });

  it("finds a tab by the name the model gave it", () => {
    const scope = freshScope();
    openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op1",
      commandHint: "npm run dev",
      terminal: "dev server",
    });
    expect(resolveTab(scope, "dev server")?.label).toBe("dev server");
    // Partial match too — the model rarely repeats a label exactly.
    expect(resolveTab(scope, "dev")?.label).toBe("dev server");
  });

  it("finds a background job's tab by its command", () => {
    const scope = freshScope();
    openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op2",
      commandHint: "npm run watch",
      background: true,
    });
    expect(resolveTab(scope, "watch")).not.toBeNull();
  });

  it("returns the retained output after the job is gone", () => {
    // The point of the fallback: the result was delivered and dropped from the
    // queue, but the tab kept a capped, persisted buffer.
    const scope = freshScope();
    const opened = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op3",
      commandHint: "npm test",
      terminal: "tests",
    });
    const id = opened.success ? opened.instanceId : "";
    // Output arrives the way it does in production — main records it as the
    // command runs. (This used to poke `lines` in through
    // `setTerminalScopeState`, which no longer accepts agent state: the
    // renderer must not be able to overwrite main's buffer.)
    appendAgentCommandOutput(scope, {
      operationId: "op3",
      command: "npm test",
      output: "PASS a.test.ts\nPASS b.test.ts",
      status: "completed",
    });

    const read = readTerminalInstance(scope, id, 200);
    expect(read.success).toBe(true);
    if (read.success) expect(read.text).toContain("PASS a.test.ts");
  });

  it("reports no match with the open tabs listed", () => {
    // The error has to name what DOES exist, or the model guesses again.
    const scope = freshScope();
    openTerminalInstance(scope, { owner: "agent", operationId: "op4" });
    expect(resolveTab(scope, "nothing-like-this")).toBeNull();
    expect(listTerminalInstances(scope).map((t) => t.label)).toContain(
      AGENT_FG_LABEL,
    );
  });

  it("caps how much is returned", () => {
    const scope = freshScope();
    const opened = openTerminalInstance(scope, {
      owner: "agent",
      operationId: "op5",
      terminal: "noisy",
    });
    const id = opened.success ? opened.instanceId : "";
    appendAgentCommandOutput(scope, {
      operationId: "op5",
      command: "noisy",
      output: Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n"),
      status: "running",
    });

    const read = readTerminalInstance(scope, id, 50);
    expect(read.success).toBe(true);
    if (read.success) {
      expect(read.text.split("\n").length).toBeLessThanOrEqual(50);
      // The TAIL is what matters — a running process's state is at the end.
      expect(read.text).toContain("line 899");
      expect(read.text).not.toContain("line 0\n");
    }
  });
});
