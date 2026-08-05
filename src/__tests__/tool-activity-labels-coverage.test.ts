/**
 * Every registered tool has a hand-written activity label.
 *
 * WHY THIS IS A TEST AND NOT A CHECKLIST
 * --------------------------------------
 * `getToolActivityLabel` / `getToolDoneLabel` fall back to a generic template when a tool
 * has no entry, so a new tool ships with a label that is *technically* fine and reads
 * wrong: "Running compress context…" instead of "Compacting context…". Nothing fails, so
 * nobody notices — this is the documented "Runned <tool>" trap, whose past instances
 * include a conjugation bug that produced literal "Runned subagents" and a `task` tool
 * whose card had no expand branch and sliced its report at 300 chars mid-token.
 *
 * It kept recurring because the requirement lived in a note ("every NEW tool needs
 * LABELS/DONE_LABELS entries") rather than in the suite. When this audit was first run it
 * found **4 of 26** live tools unlabelled: `compress_context`, `list_attachments`,
 * `read_attachment`, `schedule_wakeup`. One test replaces the checklist item permanently.
 *
 * Adding a tool without a label now fails here, with the tool's name in the message.
 */
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/index"; // side-effect: registers every tool
import {
  getToolActivityLabel,
  getToolDoneLabel,
} from "@/lib/tool-activity-labels";

/** The generic shapes the label helpers emit when a tool has no entry. */
function isGenericRunningLabel(tool: string, label: string): boolean {
  const spaced = tool.replace(/_/g, " ");
  return label === `Running ${spaced}…` || label === `Running ${spaced}`;
}
function isGenericDoneLabel(tool: string, label: string): boolean {
  return label === `Completed ${tool.replace(/_/g, " ")}`;
}

const liveTools = ToolRegistry.getAll()
  .map((t) => t.name)
  .sort();

describe("tool activity label coverage", () => {
  it("registers a non-trivial number of tools (guards the harness itself)", () => {
    // If the registry import ever stops side-effect-registering, every assertion below
    // would pass vacuously against an empty list.
    expect(liveTools.length).toBeGreaterThan(15);
  });

  it("every tool has a hand-written RUNNING label", () => {
    const missing = liveTools.filter((t) =>
      isGenericRunningLabel(t, getToolActivityLabel(t)),
    );
    expect(
      missing,
      `Add a LABELS entry in src/lib/tool-activity-labels.ts for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every tool has a hand-written DONE label", () => {
    const missing = liveTools.filter((t) =>
      isGenericDoneLabel(t, getToolDoneLabel(t)),
    );
    expect(
      missing,
      `Add a DONE_LABELS entry in src/lib/tool-activity-labels.ts for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no label is left in the present participle once done", () => {
    // "Searching code" as a DONE label reads as still-running. The conjugation fallback
    // exists for this, but a hand-written entry can still get it wrong.
    const stillRunning = liveTools.filter((t) => /\b\w+ing\b/i.test(getToolDoneLabel(t)));
    // `Finding`/`Reading` are legitimate inside a noun phrase ("Read files"), so this only
    // catches a label that is *only* a participle phrase.
    const suspicious = stillRunning.filter((t) =>
      /^(Running|Searching|Finding|Reading|Writing|Editing|Checking|Listing)\b/.test(
        getToolDoneLabel(t),
      ),
    );
    expect(
      suspicious,
      `These DONE labels read as still in progress: ${suspicious
        .map((t) => `${t}="${getToolDoneLabel(t)}"`)
        .join(", ")}`,
    ).toEqual([]);
  });

  it("no done label ends in an ellipsis", () => {
    const withEllipsis = liveTools.filter((t) => /…\s*$/u.test(getToolDoneLabel(t)));
    expect(withEllipsis).toEqual([]);
  });
});
