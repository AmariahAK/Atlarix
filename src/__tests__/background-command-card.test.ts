/**
 * QA (app) #27: a command sent to the background read "Ran command · exit 0"
 * the moment it started, and its card showed the harness's instructions to
 * the model ("You'll receive its result automatically… do not poll…"). The
 * model still gets that text; the card says the command is running.
 */
import { describe, it, expect } from "vitest";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";
import { backgroundStartedSummary } from "@/lib/chat/stream-tool-display";
import { persistedToolPartToStreamCard } from "@/lib/chat/persisted-tool-card";

const STARTED = JSON.stringify({
  success: true,
  message: "Successfully executed operation",
  output:
    'Background command started (job_id: op_1791898964672_243pv31je): sleep 20 && npm test\nYou\'ll receive its result automatically when it exits — continue other work; do not poll. Check or stop it with background_jobs({operation:"output"|"cancel", job_id:"op_1791898964672_243pv31je"}).',
  exitCode: 0,
});

describe("a command that went to the background", () => {
  it("is 'Started in the background', not 'Ran command'", () => {
    expect(backgroundStartedSummary("run_command", STARTED)).toBe("Started in the background");
    expect(backgroundStartedSummary("run_command", JSON.stringify({ output: "ok", exitCode: 0 }))).toBeNull();
    expect(
      persistedToolPartToStreamCard({ type: "tool", id: "run_command_0", toolName: "run_command", status: "success", args: { command: "sleep 20 && npm test" }, resultText: STARTED }).summary,
    ).toMatch(/^Started in the background/);
  });

  it("shows what started, with no exit code and no instructions to the model", () => {
    const view = buildToolExpandView("run_command", { command: "sleep 20 && npm test" }, STARTED, "done") as {
      kind: string;
      body: string;
      exitCode?: number;
    };
    expect(view.kind).toBe("command");
    expect(view.exitCode).toBeUndefined();
    expect(view.body).toBe("Running in the background (op_1791898964672_243pv31je): sleep 20 && npm test");
    expect(view.body).not.toMatch(/do not poll|background_jobs/);
  });
});
