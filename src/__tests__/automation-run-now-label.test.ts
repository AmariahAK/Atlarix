/**
 * Run now is the user's own run, not a scheduled fire: a notify-only run's feed
 * line is the trigger context's first line, and with none it read
 * '"<name>" fired on schedule' (app QA, 2026-10-14).
 */
import { describe, it, expect, vi } from "vitest";

const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("@/ipc/handlers/safe_handle", () => ({
  createLoggedHandler: () => (channel: string, fn: (...a: unknown[]) => unknown) => handlers.set(channel, fn),
}));
vi.mock("electron-log", () => {
  const scope = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() });
  return { default: { scope, ...scope() } };
});
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/automations/notify", () => ({ getAutomationRunView: vi.fn() }));
const enqueueRun = vi.fn();
vi.mock("@/lib/automations/runner", () => ({ enqueueRun }));

import { registerAutomationHandlers } from "@/ipc/handlers/automation_handlers";

describe("Run now", () => {
  it("queues a run that says it was started by hand", async () => {
    registerAutomationHandlers();
    await handlers.get("automations:run-now")!({}, "a1");
    expect(enqueueRun).toHaveBeenCalledTimes(1);
    const [id, context, reason] = enqueueRun.mock.calls[0]!;
    expect([id, reason]).toEqual(["a1", "manual"]);
    expect(context).toBe("Run now: started by hand, not by its schedule.");
  });
});
