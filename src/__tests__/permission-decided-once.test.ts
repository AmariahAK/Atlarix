/**
 * An operation is decided once. A rule saved on one card ("allow edits in
 * src/") approves the operations already waiting; the second card stayed on
 * screen in the CLI, was answered again, and the write ran twice (owner,
 * 2026-10-19: src/index.tsx written at 22:18:21 and again at 22:18:23).
 */
import { describe, expect, it } from "vitest";
import os from "node:os";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";

type Op = { id: string; status: string; request: { operation: string; preview: unknown } };

function interceptorWith(op: Op): PermissionInterceptor {
  const it = new PermissionInterceptor(os.tmpdir(), undefined, "turn:once");
  (it as unknown as { pendingOperations: Map<string, Op> }).pendingOperations.set(op.id, op);
  return it;
}

describe("executeOperation runs an operation at most once", () => {
  it("does not run an operation that was already executed", async () => {
    // An operation the executor does not know: running it again would throw and
    // mark it failed. Already executed, it is left exactly as it was.
    const op: Op = { id: "op_done", status: "executed", request: { operation: "no_such_operation", preview: {} } };
    const result = await interceptorWith(op).executeOperation("op_done");
    expect(result).toMatchObject({ operationId: "op_done", approved: true });
    expect(result.error).toMatch(/already executed/);
    expect(op.status).toBe("executed");
  });

  it("does not run one that was rejected", async () => {
    const op: Op = { id: "op_no", status: "rejected", request: { operation: "no_such_operation", preview: {} } };
    const result = await interceptorWith(op).executeOperation("op_no");
    expect(result.approved).toBe(false);
    expect(op.status).toBe("rejected");
  });

  it("still runs one that is pending", async () => {
    const op: Op = { id: "op_new", status: "pending", request: { operation: "no_such_operation", preview: {} } };
    await interceptorWith(op).executeOperation("op_new");
    // It ran (and this unknown operation failed), which is what proves the guard
    // lets a pending operation through.
    expect(op.status).toBe("failed");
  });
});
