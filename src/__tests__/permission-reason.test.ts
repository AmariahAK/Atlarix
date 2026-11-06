/**
 * A command's approval says, in the agent's words, why it wants to run it
 * (owner, 2026-11-06: "at the top is a English version of what it's requesting
 * to run, eg can I confirm if the pr is conflicts free"). Codex's
 * `justification`; here run_command's optional `reason`.
 *
 * The reason is model text: one line, no control characters, bounded, shown as
 * plain text, and never in place of the command (the command stays what is
 * approved).
 */
import { describe, expect, it } from "vitest";
import { approvalReason, APPROVAL_REASON_CAP } from "@/lib/tools/approval-reason";
import { summarizePermissionRequest } from "@/lib/peers/approval-summary";
import { approvalToolCall } from "@/cli/acp/permissions";
import type { PendingApproval } from "@/cli/agent/session";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools";

const REASON = "Can I check whether the PR has merge conflicts?";

describe("approvalReason", () => {
  it("keeps a short question as it is", () => {
    expect(approvalReason(REASON)).toBe(REASON);
  });
  it("one line: newlines and runs of spaces become one space", () => {
    expect(approvalReason("  Can I\n\nrun   the tests?\t ")).toBe("Can I run the tests?");
  });
  it("control characters are dropped (no escape sequences reach a terminal)", () => {
    expect(approvalReason("Can I\u001b]0;pwned\u0007 build?\u009b")).toBe("Can I]0;pwned build?");
  });
  it("bounded", () => {
    const out = approvalReason(`Can I ${"x".repeat(1000)}?`)!;
    expect(out.length).toBeLessThanOrEqual(APPROVAL_REASON_CAP);
    expect(out.endsWith("…")).toBe(true);
  });
  it("nothing, blank or not a string: no reason", () => {
    for (const v of [undefined, null, "", "   \n", 42, {}]) expect(approvalReason(v)).toBeUndefined();
  });
});

describe("run_command", () => {
  const tool = () => ToolRegistry.get("run_command")!;

  it("offers an optional reason", () => {
    const params = tool().parameters as { properties: Record<string, { description?: string }>; required?: string[] };
    expect(params.properties.reason?.description).toBeTruthy();
    expect(params.required ?? []).not.toContain("reason");
  });

  it("puts the reason on the approval request, cleaned", async () => {
    const out = (await tool().handler(
      { command: "git fetch && git merge-tree origin/main HEAD", description: "Check merge conflicts", reason: `${REASON}\n` },
      {} as never,
    )) as { preview: { reason?: string; command: string } };
    expect(out.preview.reason).toBe(REASON);
    expect(out.preview.command).toBe("git fetch && git merge-tree origin/main HEAD");
  });

  it("no reason: the request has none", async () => {
    const out = (await tool().handler({ command: "npm test", description: "Run tests" }, {} as never)) as { preview: Record<string, unknown> };
    expect(out.preview).not.toHaveProperty("reason");
  });
});

describe("a peer reviewer sees it (pending_of)", () => {
  it("in the request's detail, marked as the asking session's words", () => {
    const s = summarizePermissionRequest("op1", {
      operation: "run_command",
      preview: { command: "gh pr view 12 --json mergeable", description: "Check mergeability", reason: REASON },
    });
    expect(s.summary).toBe("gh pr view 12 --json mergeable");
    expect(s.detail?.split("\n")[0]).toBe(`reason: ${REASON}`);
    expect(s.detail).toContain("what: Check mergeability");
  });
});

describe("ACP (editors)", () => {
  const withReason: PendingApproval = {
    operationId: "op1",
    request: { operation: "run_command", preview: { command: "gh pr view 12", description: "Check mergeability", reason: REASON } },
  };

  it("the reason opens the card's text; the title is still the command", () => {
    const call = approvalToolCall(withReason);
    expect(call.title).toBe("Run gh pr view 12");
    const text = (call.content?.find((c) => c.type === "content") as { content: { text: string } }).content.text;
    expect(text.split("\n").slice(0, 2)).toEqual([`Reason: ${REASON}`, "$ gh pr view 12"]);
    expect((call._meta as { atlarix: { approval: { reason: string | null } } }).atlarix.approval.reason).toBe(REASON);
  });

  it("no reason: unchanged", () => {
    const call = approvalToolCall({ ...withReason, request: { preview: { command: "gh pr view 12" } } });
    const text = (call.content?.find((c) => c.type === "content") as { content: { text: string } }).content.text;
    expect(text.startsWith("$ gh pr view 12")).toBe(true);
    expect((call._meta as { atlarix: { approval: { reason: string | null } } }).atlarix.approval.reason).toBeNull();
  });
});
