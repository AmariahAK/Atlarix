import { describe, expect, it } from "vitest";
import {
  automationPromptSuffix,
  parseAutomationOutcome,
} from "@/lib/automations/execute-run";
import { AutomationInputSchema } from "@/lib/automations/types";
import { automationAutoApprove } from "@/lib/automations/auto-approve";
import { makeFakeSender } from "@/headless/fake-sender";

describe("parseAutomationOutcome", () => {
  it("maps the NOTHING_TO_REPORT sentinel", () => {
    expect(
      parseAutomationOutcome("I checked everything.\n\nNOTHING_TO_REPORT"),
    ).toEqual({
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
    expect(parseAutomationOutcome(null)).toEqual({
      status: "ok",
      summary: null,
    });
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

describe("AutomationInputSchema run modes", () => {
  const base = {
    name: "x",
    trigger: { kind: "schedule", cron: "0 9 * * *" },
    // Required since v14.27.0 — see the dedicated case below.
    notifyAgent: false,
  };

  it("REQUIRES notifyAgent — there is deliberately no default", () => {
    // This is the field that decides whether an automation can spend tokens in
    // chat. A default would make that call silently for whoever created it, so
    // both the user (Automations tab) and the agent (`automations` tool) have to
    // state it. Cheap to change afterwards; never assumed up front.
    const { notifyAgent: _omitted, ...withoutNotifyAgent } = base;
    expect(() => AutomationInputSchema.parse(withoutNotifyAgent)).toThrow();
    expect(
      AutomationInputSchema.parse({ ...base, notifyAgent: true }).notifyAgent,
    ).toBe(true);
    expect(AutomationInputSchema.parse(base).notifyAgent).toBe(false);
  });

  it("defaults to notify-only with no prompt required", () => {
    const parsed = AutomationInputSchema.parse(base);
    expect(parsed.runMode).toBe("notify-only");
    expect(parsed.prompt).toBe("");
  });

  it("requires a prompt for agent-run modes", () => {
    expect(() =>
      AutomationInputSchema.parse({ ...base, runMode: "read-only" }),
    ).toThrow(/need a prompt/);
    expect(
      AutomationInputSchema.parse({
        ...base,
        runMode: "read-only",
        prompt: "audit",
      }).prompt,
    ).toBe("audit");
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
        args: {
          chatId: number;
          operationId: string;
          approvalMode?: "once" | "deny";
        },
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

describe("a run whose agent turn failed (video session)", () => {
  it("is a failure with the turn's reason, not an empty ok", async () => {
    const { turnFailure } = await import("@/lib/automations/execute-run");
    const why = "Atlarix Auto isn't offered right now. Pick a Core model above, or add your own API key in Settings.";
    expect(turnFailure([{ channel: "chat:response:chunk", payload: { chatId: 7 } }, { channel: "chat:response:error", payload: { chatId: 7, error: why } }], 7)).toBe(why);
    expect(turnFailure([{ channel: "chat:stream:disconnected", payload: { chatId: 7 } }], 7)).toBe("Couldn't reach the model provider.");
    expect(turnFailure([{ channel: "chat:stream:disconnected", payload: { chatId: 7, detail: "fetch failed" } }], 7)).toBe("Couldn't reach the model provider: fetch failed");
    expect(turnFailure([{ channel: "chat:response:error", payload: { chatId: 8, error: "other chat" } }], 7)).toBeNull();
    expect(turnFailure([{ channel: "chat:response:end", payload: { chatId: 7 } }], 7)).toBeNull();
  });
});
