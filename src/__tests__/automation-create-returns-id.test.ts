/**
 * A created automation's id must reach the model.
 *
 * `operation:"create"` returns a `__permission_required` envelope, so the tool
 * result is produced BEFORE the write happens — the id is generated inside
 * `executeAutomationWrite`, after the user approves. It used to be only logged,
 * which left the model unable to `operation:"run"` the automation it had just
 * created, even though the tool's own description tells it to do exactly that.
 * Name is not a substitute: two automations may share one.
 *
 * The fix reuses the mechanism `verified` already uses for file writes — stash
 * the value on the preview at execute time so the (synchronous)
 * `getExecutionResult` can hand it back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PermissionRequest } from "@/lib/tools/permissions/schema";

const createAutomation = vi.fn();
vi.mock("@/lib/automations/service", () => ({
  createAutomation: (...args: unknown[]) => createAutomation(...args),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
}));

vi.mock("@/lib/automations/types", () => ({
  AutomationInputSchema: { parse: (v: unknown) => v },
}));

const createRequest = (): PermissionRequest =>
  ({
    __permission_required: true,
    operation: "automation_write",
    preview: {
      action: "create",
      name: "Nightly audit",
      triggerSummary: "every weekday at 09:00",
      description: 'Create the automation "Nightly audit"',
      input: { name: "Nightly audit" },
    },
  }) as unknown as PermissionRequest;

async function newInterceptor() {
  const { PermissionInterceptor } = await import(
    "@/ipc/handlers/permissions/interceptor"
  );
  // executeAutomationWrite needs a workspaceId to create in.
  return new PermissionInterceptor("/tmp/atlarix-test-workspace", 7);
}

describe("automations create hands its id back to the model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAutomation.mockResolvedValue({ id: "auto_abc123" });
  });

  it("reports automationId from getExecutionResult after approval", async () => {
    const interceptor = await newInterceptor();
    interceptor.bufferOperation("op-1", createRequest(), true);

    await interceptor.executeOperation("op-1");

    const result = interceptor.getExecutionResult("op-1");
    expect(result.success).toBe(true);
    expect(result.automationId).toBe("auto_abc123");
  });

  it("stashes the id on the preview, which is what carries it out", async () => {
    const interceptor = await newInterceptor();
    const request = createRequest();
    interceptor.bufferOperation("op-2", request, true);

    await interceptor.executeOperation("op-2");

    expect(
      (request.preview as { automationId?: string }).automationId,
    ).toBe("auto_abc123");
  });

  it("does not invent an id when the service returns none", async () => {
    createAutomation.mockResolvedValue({ id: undefined });
    const interceptor = await newInterceptor();
    interceptor.bufferOperation("op-3", createRequest(), true);

    await interceptor.executeOperation("op-3");

    const result = interceptor.getExecutionResult("op-3");
    expect(result.success).toBe(true);
    expect(result.automationId).toBeUndefined();
  });
});
