/**
 * A sub-agent's command, routed through the parent turn's interceptor.
 *
 * The properties that matter here are all about what a worker CANNOT do:
 * it cannot escape the read-only sandbox, it cannot drop the sandbox by claiming
 * a human approved a system-scope command, it cannot ask anonymously, and it
 * cannot hang forever when the parent turn has gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Records what the interceptor was handed, so we can assert on the request. */
let buffered: Array<{ id: string; request: any; silent: boolean }> = [];
let executed: string[] = [];
let approvalOutcome: "approved" | "rejected" | "undecided" = "approved";
let interceptorPresent = true;

const fakeInterceptor = {
  parsePermissionRequest: (r: unknown) => r as any,
  generateOperationId: () => "op_test_1",
  bufferOperation: (id: string, request: any, silent = false) => {
    buffered.push({ id, request, silent });
  },
  executeOperation: async (id: string) => {
    executed.push(id);
    return { operationId: id, approved: true };
  },
  waitForApproval: async () => approvalOutcome,
  getExecutionResult: () => ({
    success: true,
    command: "npm test",
    output: "ok",
    exitCode: 0,
  }),
};

vi.mock("@/ipc/handlers/permissions/handlers", () => ({
  getInterceptorForChat: () =>
    interceptorPresent ? fakeInterceptor : undefined,
}));

/** Identity enrichment — the real one needs DB-backed workspace rules. */
vi.mock("@/ipc/handlers/chat_stream/permission-ui", () => ({
  enrichRunCommandPermissionRequest: (r: unknown) => r,
}));

let verdict: { type: string; category?: string } = {
  type: "auto_allow",
  category: "npm",
};
vi.mock("@/ipc/handlers/command_permission_handlers", () => ({
  runCommandCategoryPreflight: () => verdict,
}));

const { runSubagentCommandViaParent } = await import(
  "@/lib/agents/subagent-command"
);

function envelope(command: string, extra: Record<string, unknown> = {}) {
  return {
    __permission_required: true,
    operation: "run_command",
    preview: { command, description: "test", ...extra },
  };
}

function call(command: string, extra: Record<string, unknown> = {}) {
  return runSubagentCommandViaParent({
    chatId: -60,
    agentName: "qa",
    workspaceId: 7,
    workspacePath: "/tmp/ws",
    envelope: envelope(command, extra),
  });
}

beforeEach(() => {
  buffered = [];
  executed = [];
  approvalOutcome = "approved";
  interceptorPresent = true;
  verdict = { type: "auto_allow", category: "npm" };
});

describe("sub-agent command routing", () => {
  it("forces the read-only sandbox on every command", async () => {
    await call("npm test");
    // Without this the worker inherits the PARENT turn's mode, so a QA agent
    // spawned from a Build turn would get workspace-write — the opposite of a
    // worker whose job is to observe.
    expect(buffered[0].request.preview.readOnly).toBe(true);
  });

  it("cannot opt out of read-only by asking", async () => {
    await call("npm test", { readOnly: false });
    expect(buffered[0].request.preview.readOnly).toBe(true);
  });

  it("cannot drop the sandbox by claiming a human approved a system-scope command", async () => {
    // `systemScopeInteractive` is the flag that lets an interactively-approved
    // system-scope command run UNSANDBOXED. A worker must never be able to set it.
    await call("brew install jq", { systemScopeInteractive: true });
    expect(buffered[0].request.preview.systemScopeInteractive).toBeUndefined();
  });

  it("labels the ask with the agent that made it", async () => {
    await call("npm test");
    // An unlabelled ask from a worker the user did not know was running is worse
    // than no ask — they cannot tell who decided to do this.
    expect(buffered[0].request.preview.requestedByAgent).toBe("qa");
  });

  it("auto-runs a non-dangerous command with no card", async () => {
    verdict = { type: "auto_allow", category: "npm" };
    const out = await call("npm test");
    expect(buffered[0].silent).toBe(true);
    expect(executed).toEqual(["op_test_1"]);
    expect(out.success).toBe(true);
    expect(out.output).toBe("ok");
  });

  it("raises a visible card for anything that is not auto-allowed", async () => {
    verdict = { type: "prompt", category: "rm" };
    await call("rm -rf build");
    expect(buffered[0].silent).toBe(false);
  });

  it("a declined command fails THAT call only, and says not to retry", async () => {
    verdict = { type: "prompt", category: "rm" };
    approvalOutcome = "rejected";
    const out = await call("rm -rf build");
    expect(out.success).toBe(false);
    expect(out.denied).toBe(true);
    expect(out.error).toMatch(/do not retry/i);
  });

  it("treats an undecided wait as a decline, never as consent", async () => {
    verdict = { type: "prompt", category: "rm" };
    approvalOutcome = "undecided";
    const out = await call("rm -rf build");
    expect(out.success).toBe(false);
    expect(out.denied).toBe(true);
  });

  it("respects a workspace always-deny rule without asking", async () => {
    verdict = { type: "auto_deny", category: "curl" };
    const out = await call("curl example.com");
    expect(out.success).toBe(false);
    expect(out.denied).toBe(true);
    expect(buffered).toHaveLength(0);
  });

  it("fails with a usable reason when the parent turn is gone", async () => {
    // A worker can outlive its parent (cancelled turn). Hanging on an approval
    // nobody will ever see is the failure mode to avoid.
    interceptorPresent = false;
    const out = await call("npm test");
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no longer active/i);
    expect(buffered).toHaveLength(0);
  });
});
