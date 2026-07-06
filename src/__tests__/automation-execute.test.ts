import { describe, expect, it } from "vitest";
import {
  automationPromptSuffix,
  parseAutomationOutcome,
} from "@/lib/automations/execute-run";
import { automationAutoApprove } from "@/lib/automations/auto-approve";
import { makeFakeSender } from "@/headless/fake-sender";

describe("parseAutomationOutcome", () => {
  it("maps the NOTHING_TO_REPORT sentinel", () => {
    expect(parseAutomationOutcome("I checked everything.\n\nNOTHING_TO_REPORT")).toEqual({
      status: "nothing-to-report",
      summary: null,
    });
  });

  it("extracts the AUTOMATION_RESULT summary", () => {
    const out = parseAutomationOutcome(
      "Long analysis...\nAUTOMATION_RESULT: 3 flaky tests found in auth suite",
    );
    expect(out.status).toBe("ok");
    expect(out.summary).toBe("3 flaky tests found in auth suite");
  });

  it("defensively surfaces runs that forgot the contract", () => {
    const out = parseAutomationOutcome("Some findings\nwith no sentinel line");
    expect(out.status).toBe("ok");
    expect(out.summary).toContain("no sentinel line");
  });

  it("handles empty/null output", () => {
    expect(parseAutomationOutcome(null)).toEqual({ status: "ok", summary: null });
  });
});

describe("automationPromptSuffix", () => {
  it("states unattended semantics and both sentinels", () => {
    const s = automationPromptSuffix("Nightly audit");
    expect(s).toContain("UNATTENDED");
    expect(s).toContain("Nightly audit");
    expect(s).toContain("AUTOMATION_RESULT:");
    expect(s).toContain("NOTHING_TO_REPORT");
  });
});

describe("automationAutoApprove", () => {
  it("approves normal ops and ALWAYS denies dangerous ones (no env escape)", async () => {
    process.env.ATLARIX_AUTONOMOUS_DANGER = "1"; // must be ignored, unlike headless
    try {
      const sender = makeFakeSender();
      const calls: Array<{ operationId: string; approvalMode?: string }> = [];
      const executePermission = async (
        _event: unknown,
        args: { chatId: number; operationId: string; approvalMode?: "once" | "deny" },
      ) => {
        calls.push(args);
        return { success: true };
      };

      sender.event.sender.send("permission-request", {
        chatId: -5,
        operationId: "op-safe",
        request: { preview: { isDangerous: false } },
      });
      sender.event.sender.send("permission-request", {
        chatId: -5,
        operationId: "op-danger",
        request: { preview: { isDangerous: true } },
      });
      // Different chat — must be ignored.
      sender.event.sender.send("permission-request", {
        chatId: -6,
        operationId: "op-other-chat",
        request: { preview: { isDangerous: false } },
      });
      setTimeout(() => {
        sender.event.sender.send("chat:response:end", { chatId: -5 });
      }, 100);

      await automationAutoApprove({
        sender,
        executePermission,
        chatId: -5,
        timeoutMs: 5000,
      });

      const byOp = new Map(calls.map((c) => [c.operationId, c.approvalMode]));
      expect(byOp.get("op-safe")).toBe("once");
      expect(byOp.get("op-danger")).toBe("deny");
      expect(byOp.has("op-other-chat")).toBe(false);
    } finally {
      delete process.env.ATLARIX_AUTONOMOUS_DANGER;
    }
  });
});
