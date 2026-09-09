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
      new Promise<typeof stillPending>((r) =>
        setTimeout(() => r(stillPending), 50),
      ),
    ]);
    // The old grace window (4s → "undecided") is gone; after 50ms it's still blocked.
    expect(raced).toBe(stillPending);
  });

  it("rejects (AbortError) when the turn's signal aborts (Stop)", async () => {
    const interceptor = new PermissionInterceptor("/tmp/atlarix-test-ws");
    const ac = new AbortController();
    const wait = interceptor.waitForApproval("op-abort", {
      abortSignal: ac.signal,
    });
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

/**
 * The ESCALATION lanes had no signal to pass, so Stop could not unwind them.
 *
 * `ensureOutsideTargetsGranted` and `maybeEscalateSandboxDenial` call
 * `waitForApproval` from inside `executeOperation`, several frames beneath the
 * branch runner that owns the AbortController — so unlike every other caller they
 * passed nothing and blocked forever.
 *
 * Observed: an `edit_file` into the agent-memory directory raised the folder-grant
 * card and blocked for 10 minutes 18 seconds. Stop did nothing, because nothing was
 * listening; clicking the card afterwards STILL completed the write, because the
 * promise had never been cancellable. The turn looked hung and was in fact waiting,
 * unstoppably.
 *
 * The signal now rides on the interceptor, which is per-turn and never reused — the
 * same lifetime argument as `turnWorkMode`.
 */
describe("escalation waits are cancellable by the turn's Stop", () => {
  const WS = "/tmp/atlarix-escalation-ws";

  it("an outside-folder grant unwinds when the turn aborts", async () => {
    const ac = new AbortController();
    const interceptor = new PermissionInterceptor(
      WS,
      undefined,
      undefined,
      1,
      "build",
      ac.signal,
    ) as unknown as {
      ensureOutsideTargetsGranted: (
        operationId: string,
        paths: string[],
      ) => Promise<void>;
    };

    const pending = interceptor.ensureOutsideTargetsGranted("op-esc", [
      "/tmp/somewhere-else/notes.md",
    ]);
    // Nothing has decided yet — this is the state the user sat in for 10 minutes.
    ac.abort();

    // It must SETTLE. Before the fix this promise never resolved or rejected.
    await expect(pending).rejects.toThrow();
  });

  it("still does not resolve on its own while the turn is alive", async () => {
    const ac = new AbortController();
    const interceptor = new PermissionInterceptor(
      WS,
      undefined,
      undefined,
      1,
      "build",
      ac.signal,
    ) as unknown as {
      ensureOutsideTargetsGranted: (
        operationId: string,
        paths: string[],
      ) => Promise<void>;
    };

    const pending = interceptor
      .ensureOutsideTargetsGranted("op-esc-2", ["/tmp/elsewhere/x.md"])
      .then(() => "settled" as const)
      .catch(() => "settled" as const);

    const stillWaiting = Symbol("still-waiting");
    const raced = await Promise.race([
      pending,
      new Promise<typeof stillWaiting>((r) =>
        setTimeout(() => r(stillWaiting), 50),
      ),
    ]);
    // A grant must never expire into a decision — cancellable is not the same as
    // self-resolving.
    expect(raced).toBe(stillWaiting);
    ac.abort();
  });
});
