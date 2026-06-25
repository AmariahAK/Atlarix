import { describe, expect, it } from "vitest";
import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";

// v14.7 #1: approvals BLOCK the turn mid-loop until the user decides — no grace
// timeout / park. The wait is indefinite and cancellable via the turn's abort
// signal (Stop). (Approve/reject → execute/reject outcomes are covered by the
// `edit-with-approval` eval; here we lock the new block + abort behavior.)
describe("waitForApproval — v14.7 indefinite mid-loop block", () => {
  it("does NOT auto-resolve (no grace timeout) — stays pending until a decision", async () => {
    const interceptor = new PermissionInterceptor("/tmp/atlarix-test-ws");
    const wait = interceptor.waitForApproval("op-block");
    const stillPending = Symbol("still-pending");
    const raced = await Promise.race([
      wait.then(() => "resolved" as const),
      new Promise<typeof stillPending>((r) => setTimeout(() => r(stillPending), 50)),
    ]);
    // The old grace window (4s → "undecided") is gone; after 50ms it's still blocked.
    expect(raced).toBe(stillPending);
  });

  it("rejects (AbortError) when the turn's signal aborts (Stop)", async () => {
    const interceptor = new PermissionInterceptor("/tmp/atlarix-test-ws");
    const ac = new AbortController();
    const wait = interceptor.waitForApproval("op-abort", { abortSignal: ac.signal });
    ac.abort();
    await expect(wait).rejects.toThrow();
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const interceptor = new PermissionInterceptor("/tmp/atlarix-test-ws");
    const ac = new AbortController();
    ac.abort();
    await expect(
      interceptor.waitForApproval("op-pre", { abortSignal: ac.signal }),
    ).rejects.toThrow();
  });
});
