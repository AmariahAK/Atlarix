/**
 * C3 — background-job reference chip: label is `id-<jobId>`; the model gets the
 * job id, command, and output tail via `<atlarix-background-job>`.
 */
import { describe, expect, it } from "vitest";
import {
  isBackgroundJobAttachment,
  backgroundJobDisplayName,
  buildBackgroundJobModelBlock,
  buildBackgroundJobDisplayBlock,
  type BackgroundJobAttachment,
} from "@/lib/chat/background-job-attachment";
import { buildPastePromptsFromAttachments } from "@/lib/chat/attachment-tag-blocks";

const att: BackgroundJobAttachment = {
  type: "chat-context",
  backgroundJob: {
    jobId: "op-7f3a",
    command: "ssh prod 'tail -f /var/log/app.log'",
    outputTail: "Connecting…\n(no further output for 3m)",
  },
};

describe("background-job-attachment (C3)", () => {
  it("type guard + display name (`id-<jobId>`)", () => {
    expect(isBackgroundJobAttachment(att)).toBe(true);
    expect(isBackgroundJobAttachment({ type: "chat-context" })).toBe(false);
    expect(backgroundJobDisplayName("op-7f3a")).toBe("id-op-7f3a");
  });

  it("model block carries job id, command, and output tail", () => {
    const model = buildBackgroundJobModelBlock(att);
    expect(model).toContain('job_id="op-7f3a"');
    expect(model).toContain("ssh prod");
    expect(model).toContain("no further output for 3m");

    const display = buildBackgroundJobDisplayBlock(att);
    expect(display).toContain('job_id="op-7f3a"');
    expect(display).not.toContain("var/log"); // no command/output in display stub
  });

  it("falls back to a placeholder when no output captured", () => {
    const block = buildBackgroundJobModelBlock({
      type: "chat-context",
      backgroundJob: { jobId: "x", command: "sleep 99" },
    });
    expect(block).toContain("(no output captured yet)");
  });

  it("buildPastePromptsFromAttachments injects the job block, keeps display clean", () => {
    const { modelPrompt, displayPrompt } = buildPastePromptsFromAttachments(
      "Is this job stuck?",
      [att],
    );
    expect(modelPrompt).toContain("Is this job stuck?");
    expect(modelPrompt).toContain("<atlarix-background-job");
    expect(modelPrompt).toContain("op-7f3a");
    expect(modelPrompt).toContain("no further output for 3m");

    expect(displayPrompt).toContain("Is this job stuck?");
    expect(displayPrompt).not.toContain("no further output for 3m"); // tail not shown
  });
});
