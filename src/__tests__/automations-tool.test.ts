/**
 * The `automations` tool: nothing mutates without approval, and `notifyAgent`
 * genuinely governs whether a run can reach the model.
 *
 * The second half is the one that matters. `notifyAgent` is the field that
 * decides whether a standing, recurring job can spend tokens while nobody is
 * watching — if it were ever ignored, the failure would be an invisible bill
 * rather than an error.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const listAutomations = vi.fn();
const getAutomation = vi.fn();

/** chatId → workspaceId, the mapping automation results resolve through. */
let chatToWorkspace: Record<number, number> = {};
vi.mock("@/lib/chat/stream-transport", () => ({
  getStreamTransportAppId: (chatId: number) => chatToWorkspace[chatId] ?? null,
}));

vi.mock("@/lib/automations/service", () => ({
  listAutomations: (...a: unknown[]) => listAutomations(...a),
  getAutomation: (...a: unknown[]) => getAutomation(...a),
}));

import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/automations";
import {
  recordAutomationResult,
  takePendingAutomationResults,
  clearAutomationResultsForTests,
} from "@/lib/agent/automation-results";

const tool = () => ToolRegistry.get("automations")!;
const WS = 7;

const scheduleTrigger = { kind: "schedule", cron: "0 9 * * 1-5" };

beforeEach(() => {
  listAutomations.mockReset();
  getAutomation.mockReset();
  clearAutomationResultsForTests();
  listAutomations.mockResolvedValue({ automations: [], unreadCount: 0 });
});

describe("automations tool — mutations require approval", () => {
  it("list returns data directly, with no permission envelope", async () => {
    listAutomations.mockResolvedValue({
      automations: [
        {
          id: "a1",
          name: "CI",
          enabled: true,
          trigger: scheduleTrigger,
          runMode: "notify-only",
          notifyAgent: true,
          lastRunAt: null,
        },
      ],
      unreadCount: 0,
    });
    const r = (await tool().handler({
      operation: "list",
      workspaceId: WS,
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(r.__permission_required).toBeUndefined();
    expect((r.automations as unknown[])[0]).toMatchObject({
      notify_agent: true,
      run_mode: "notify-only",
    });
  });

  it("create asks first and writes nothing", async () => {
    const r = (await tool().handler({
      operation: "create",
      workspaceId: WS,
      name: "CI failures",
      trigger: scheduleTrigger,
      notify_agent: true,
    })) as Record<string, unknown>;
    expect(r.__permission_required).toBe(true);
    expect(r.operation).toBe("automation_write");
    const preview = r.preview as Record<string, unknown>;
    expect(preview.action).toBe("create");
    // The card must carry the two fields that decide unattended spend.
    expect(preview.notifyAgent).toBe(true);
    expect(preview.runMode).toBe("notify-only");
    expect(preview.input).toBeTruthy();
  });

  it("refuses to create without notify_agent rather than picking one", async () => {
    const r = (await tool().handler({
      operation: "create",
      workspaceId: WS,
      name: "CI failures",
      trigger: scheduleTrigger,
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(r.__permission_required).toBeUndefined();
  });

  it("delete asks first, and names what would go", async () => {
    getAutomation.mockResolvedValue({
      id: "a1",
      name: "CI failures",
      trigger: scheduleTrigger,
      prompt: "",
      runMode: "notify-only",
      notifyAgent: false,
      enabled: true,
    });
    const r = (await tool().handler({
      operation: "delete",
      workspaceId: WS,
      automation_id: "a1",
    })) as Record<string, unknown>;
    expect(r.__permission_required).toBe(true);
    expect((r.preview as Record<string, unknown>).action).toBe("delete");
    expect((r.preview as Record<string, unknown>).name).toBe("CI failures");
  });

  it("set_notify shows the before → after, so the card is not just a name", async () => {
    getAutomation.mockResolvedValue({
      id: "a1",
      name: "Slack",
      trigger: scheduleTrigger,
      prompt: "",
      runMode: "notify-only",
      notifyAgent: false,
      enabled: true,
    });
    const r = (await tool().handler({
      operation: "set_notify",
      workspaceId: WS,
      automation_id: "a1",
      notify_agent: true,
    })) as Record<string, unknown>;
    const preview = r.preview as Record<string, unknown>;
    expect(preview.notifyAgent).toBe(true);
    expect((preview.changes as string[])[0]).toContain("false → true");
  });

  it("reports a missing automation instead of asking to change nothing", async () => {
    getAutomation.mockResolvedValue(null);
    const r = (await tool().handler({
      operation: "delete",
      workspaceId: WS,
      automation_id: "gone",
    })) as Record<string, unknown>;
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain("gone");
  });

  it("says so when an update would change nothing", async () => {
    getAutomation.mockResolvedValue({
      id: "a1",
      name: "CI",
      trigger: scheduleTrigger,
      prompt: "",
      runMode: "notify-only",
      notifyAgent: true,
      enabled: true,
    });
    const r = (await tool().handler({
      operation: "update",
      workspaceId: WS,
      automation_id: "a1",
      notify_agent: true,
    })) as Record<string, unknown>;
    expect(r.success).toBe(true);
    expect(r.__permission_required).toBeUndefined();
  });
});

describe("automation result delivery", () => {
  const CHAT = 55;
  beforeEach(() => {
    chatToWorkspace = { [CHAT]: WS };
  });

  it("reaches ANY chat in the same workspace, not one it was spawned from", () => {
    // The structural difference from sub-agent results: an automation fires on a
    // timer, so the chat that will read it may not have existed when it ran.
    recordAutomationResult(WS, {
      automationId: "a1",
      automationName: "CI failures",
      status: "error",
      body: "build failed on main",
      finishedAt: Date.now(),
    });
    const body = takePendingAutomationResults(CHAT);
    expect(body).toContain("CI failures");
    expect(body).toContain("build failed on main");
  });

  it("is take-once, so a result is never delivered twice", () => {
    recordAutomationResult(WS, {
      automationId: "a1",
      automationName: "CI",
      status: "ok",
      body: "green",
      finishedAt: Date.now(),
    });
    expect(takePendingAutomationResults(CHAT)).toContain("green");
    expect(takePendingAutomationResults(CHAT)).toBeNull();
  });

  it("does not deliver into a DIFFERENT workspace's chat", () => {
    recordAutomationResult(WS, {
      automationId: "a1",
      automationName: "CI",
      status: "ok",
      body: "green",
      finishedAt: Date.now(),
    });
    chatToWorkspace[999] = 4242;
    expect(takePendingAutomationResults(999)).toBeNull();
    // …and the real workspace still has it.
    expect(takePendingAutomationResults(CHAT)).toContain("green");
  });
});

/**
 * Every operation the handler accepts must be ADVERTISED.
 *
 * `run` shipped once with the enum and handler in place but no mention in the
 * description — which makes it not exist, because the description is the only
 * place the model learns what the tool can do. Same shape as the "Runned <tool>"
 * label trap: the capability works and is undiscoverable.
 */
describe("automations — the description matches the enum", () => {
  it("advertises every operation the tool accepts", () => {
    const tool = ToolRegistry.get("automations");
    expect(tool).toBeTruthy();
    const description = tool!.description;
    const accepted = (
      tool!.parameters as { properties?: { operation?: { enum?: string[] } } }
    ).properties?.operation?.enum;
    expect(accepted, "operation should be an enum param").toBeTruthy();

    const undocumented = accepted!.filter((op) => !description.includes(`operation:"${op}"`));
    expect(
      undocumented,
      `these operations are accepted but never described, so the model cannot know they exist: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("tells the model that run targets ONE automation", () => {
    const description = ToolRegistry.get("automations")!.description;
    expect(description).toContain('operation:"run"');
    expect(description).toContain("automation_id");
  });
});
