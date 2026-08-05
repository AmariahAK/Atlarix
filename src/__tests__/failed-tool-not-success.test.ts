/**
 * A tool that FAILED must not render as an accomplishment.
 *
 * Tools report failure two ways: by THROWING, and by RETURNING a failure shape
 * (`{success:false, …}`, or the legacy bare `{error:"…"}` that `edit_file`/`plan` use).
 * The registry normalizes both into the same error envelope, so the MODEL sees either as a
 * failure.
 *
 * The UI did not. `activityStatus` in the build/ask turn runners was assigned only inside a
 * `catch`, so a RETURNED failure emitted `status: "done"` — the card's icon is driven by
 * status, and its words came from `getToolCompletedSummary`, which is past-tense success
 * prose. A `glob` refusing a pattern therefore rendered as **"Found files matching
 * ../telios/*"** with a green tick, beside its own error text.
 *
 * Same class as v14.22.0's `run_command` reporting "Successfully executed" next to a
 * non-zero exit — and it affected every tool using the return convention, not just `glob`.
 */
import { describe, expect, it } from "vitest";
import {
  isFailedToolResult,
  toolActivityStatusFor,
} from "@/lib/tools/tool-result-status";
import {
  getToolCompletedSummary,
  getToolFailedSummary,
} from "@/lib/chat/stream-tool-display";
import {
  handleStreamToolEnd,
  streamThreadItemFromActivity,
  type StreamThreadItem,
} from "@/lib/chat/stream-thread";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";

describe("isFailedToolResult", () => {
  it("detects the explicit convention", () => {
    expect(isFailedToolResult({ success: false, error: "nope" })).toBe(true);
  });

  it("detects the legacy bare-error convention (edit_file / plan)", () => {
    expect(isFailedToolResult({ error: "Missing required parameter: path" })).toBe(true);
  });

  it("does not override a tool that explicitly succeeded", () => {
    expect(isFailedToolResult({ success: true, error: null })).toBe(false);
    expect(isFailedToolResult({ success: true, error: "" })).toBe(false);
    // A successful result may legitimately carry an `error` FIELD it set to a message
    // about something else; `success: true` wins.
    expect(isFailedToolResult({ success: true, error: "warn: deprecated" })).toBe(false);
  });

  it("is false for ordinary successful results", () => {
    expect(isFailedToolResult("Found 3 files")).toBe(false);
    expect(isFailedToolResult({ files: ["a.ts"] })).toBe(false);
    expect(isFailedToolResult([1, 2, 3])).toBe(false);
    expect(isFailedToolResult(null)).toBe(false);
    expect(isFailedToolResult(undefined)).toBe(false);
    expect(isFailedToolResult({ error: "" })).toBe(false); // empty is not an error
    expect(isFailedToolResult({ error: 42 })).toBe(false); // non-string is not the convention
  });
});

describe("toolActivityStatusFor", () => {
  it("maps a RETURNED failure to error — the bug", () => {
    // This is the whole fix: before, only `threw` produced "error".
    expect(toolActivityStatusFor({ success: false, error: "bad pattern" })).toBe("error");
  });

  it("maps a throw to error regardless of result", () => {
    expect(toolActivityStatusFor(undefined, { threw: true })).toBe("error");
    expect(toolActivityStatusFor("all good", { threw: true })).toBe("error");
  });

  it("maps success to done", () => {
    expect(toolActivityStatusFor("Found 3 files")).toBe("done");
  });
});

describe("getToolFailedSummary", () => {
  it("names the attempt, not the accomplishment", () => {
    const args = { pattern: "../telios/*" };
    const done = getToolCompletedSummary("glob", args);
    const failed = getToolFailedSummary("glob", args);

    // The reported symptom, verbatim.
    expect(done).toContain("Found files matching");
    expect(failed).not.toContain("Found files matching");
    expect(failed).toMatch(/^Failed:/);
  });

  it("keeps the arg detail so the user sees WHAT was tried", () => {
    expect(getToolFailedSummary("glob", { pattern: "../telios/*" })).toContain(
      "../telios/*",
    );
  });

  it("drops the in-progress ellipsis — a settled failure is not still running", () => {
    expect(getToolFailedSummary("grep", { pattern: "foo" })).not.toContain("…");
  });

  it("still says something for an unknown tool with no args", () => {
    expect(getToolFailedSummary("some_new_tool").length).toBeGreaterThan(0);
  });
});

/** A running `glob` card, as the thread holds it before the result arrives. */
function runningGlobCard(): StreamThreadItem[] {
  return [
    {
      kind: "tool",
      id: "call-1",
      toolName: "glob",
      summary: "Finding files",
      status: "running",
      toolArgs: { pattern: "../telios/*" },
      ts: 1,
    } as StreamThreadItem,
  ];
}

describe("the thread card for a failed call", () => {
  it("carries error status and a non-success summary", () => {
    const next = handleStreamToolEnd(runningGlobCard(), {
      toolCallId: "call-1",
      toolName: "glob",
      status: "error",
      detail: "glob pattern may not contain '..'",
    });
    const card = next[0] as Extract<StreamThreadItem, { kind: "tool" }>;
    expect(card.status).toBe("error");
    // `ToolStatusIcon` renders the failure state from `status`; the words must agree.
    expect(card.summary).not.toContain("Found files matching");
    expect(card.summary).toMatch(/^Failed:/);
  });

  it("still reads as success when the call actually succeeded", () => {
    const next = handleStreamToolEnd(runningGlobCard(), {
      toolCallId: "call-1",
      toolName: "glob",
      status: "done",
      detail: "Found 3 file(s)",
    });
    const card = next[0] as Extract<StreamThreadItem, { kind: "tool" }>;
    expect(card.status).toBe("done");
    expect(card.summary).toContain("Found files matching");
  });

  it("an error activity item builds a failed card, not a done one", () => {
    const activity: ActivityStreamItem = {
      id: "act-1",
      type: "tool_use",
      toolName: "glob",
      toolCallId: "call-9",
      status: "error",
      detail: "glob pattern may not contain '..'",
      timestamp: 2,
      chatId: 1,
      toolArgs: { pattern: "../telios/*" },
    } as unknown as ActivityStreamItem;

    const item = streamThreadItemFromActivity(activity);
    expect(item?.kind).toBe("tool");
    if (item?.kind !== "tool") return;
    expect(item.status).toBe("error");
    expect(item.summary).not.toContain("Found files matching");
  });
});
