/**
 * "Successfully wrote README.md, added: 0, removed: 0" — a success carrying an
 * empty diff, for a write that really happened.
 *
 * OBSERVED LIVE 2026-09-11 (op_1789120127239_9w4wgisfg). The user clicked
 * "Approve rest of turn", which routes through `executeAllOperations`. That
 * method deletes every operation it ran from `pendingOperations` — and the build
 * branch then calls `getExecutionResult(operationId)`, which found nothing and
 * returned `{ success: false, error: "Operation ... not found" }`. Its caller had
 * already decided the write succeeded, so it announced success while the diff
 * counts (computed from the now-missing old/new content) came back 0/0.
 *
 * The model disbelieved the result and spent a turn on `git diff` to find out
 * whether its own edit had landed — which is the user-visible bug.
 *
 * Single-approve did not evict, so it always worked. That is why this looked
 * intermittent rather than broken.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The write path reaches for snapshots, ledgers and stats. None of them bear on
// what this test pins, and all of them want a database.
vi.mock("@/lib/snapshots/snapshot-manager", () => ({
  captureWorkspaceSnapshot: vi.fn(async () => null),
  initShadowRepo: vi.fn(async () => {}),
}));
vi.mock("@/lib/stats/edit-stats", () => ({
  recordEditStatsSafely: vi.fn(),
  computeLineDelta: vi.fn(() => ({ added: 0, removed: 0 })),
}));

import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "atlarix-evict-"));
});

/** The exact request shape `edit_file` emits for a surgical replace. */
function editRequest(path: string, oldContent: string, newContent: string) {
  return {
    operation: "edit_file",
    preview: {
      path,
      content: newContent,
      oldContent,
      description: "Surgical replace",
      type: "update" as const,
      lines: newContent.split("\n").length,
    },
    reasoning: "test",
  };
}

describe("execution result survives pendingOperations eviction", () => {
  it("still reports the real diff after executeAllOperations evicted the op", async () => {
    writeFileSync(join(workspace, "README.md"), "one\ntwo\n", "utf-8");
    const interceptor = new PermissionInterceptor(workspace);
    const id = "op_test_evicted";
    interceptor.bufferOperation(
      id,
      editRequest("README.md", "one\ntwo\n", "one\ninserted\ntwo\n") as never,
    );

    // The "Approve rest of turn" path: execute the batch, then evict.
    await interceptor.executeAllOperations();

    // The bytes really landed.
    expect(readFileSync(join(workspace, "README.md"), "utf-8")).toBe(
      "one\ninserted\ntwo\n",
    );

    // ...and the result the model is shown says so, rather than "not found".
    const result = interceptor.getExecutionResult(id);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.path).toBe("README.md");
    expect(result.operation).toBe("update");
    expect(result.oldContent).toBe("one\ntwo\n");
    expect(result.newContent).toBe("one\ninserted\ntwo\n");
  });

  it("carries `verified` through, so the self-review gate still sees a bad write", async () => {
    writeFileSync(join(workspace, "a.txt"), "before\n", "utf-8");
    const interceptor = new PermissionInterceptor(workspace);
    const id = "op_test_verified";
    interceptor.bufferOperation(
      id,
      editRequest("a.txt", "before\n", "after\n") as never,
    );
    await interceptor.executeAllOperations();

    // Losing this to eviction was the quiet half of the bug: `verified`
    // came back undefined, which is falsy, so an unverified write took the
    // "all good" branch and CLEARED its flag instead of recording it.
    expect(interceptor.getExecutionResult(id).verified).toBe(true);
  });

  it("surfaces a fuzzy-match notice that eviction used to swallow", async () => {
    writeFileSync(join(workspace, "b.txt"), "x\n", "utf-8");
    const interceptor = new PermissionInterceptor(workspace);
    const id = "op_test_notice";
    const req = editRequest("b.txt", "x\n", "y\n") as never as {
      preview: { notice?: string };
    };
    req.preview.notice = "Matched fuzzily at line 3.";
    interceptor.bufferOperation(id, req as never);
    await interceptor.executeAllOperations();

    expect(interceptor.getExecutionResult(id).output).toBe(
      "Matched fuzzily at line 3.",
    );
  });

  it("still reports not-found for an id that never existed", () => {
    const interceptor = new PermissionInterceptor(workspace);
    const result = interceptor.getExecutionResult("op_never_seen");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});
