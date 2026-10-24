/**
 * The approvals bar above the composer.
 *
 * Cards render inline in the transcript, which is right for the record and wrong
 * for acting: on a long turn the card scrolls away, and a pending approval went
 * unnoticed until you scrolled all the way back. This bar is the actionable
 * surface, always in view.
 *
 * The property that matters is that it appears when — and only when — something
 * is genuinely waiting. A bar that quietly stops rendering puts you back where
 * you started, with nothing to notice.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import {
  permissionQueueAtom,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc() as ReturnType<typeof makeFakeIpc> & {
  executeAllPermissions: ReturnType<typeof vi.fn>;
  approveAllForTurn: ReturnType<typeof vi.fn>;
};
fakeIpc.executeAllPermissions = vi.fn(async () => []);
fakeIpc.approveAllForTurn = vi.fn(async () => []);
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const { PendingApprovalsBar, describePending } = await import(
  "@/components/chat/PendingApprovalsBar"
);

const CHAT = -28;

function op(over: Partial<QueuedOperation> = {}): QueuedOperation {
  return {
    id: over.id ?? "op1",
    // Every queued card carries its chat since 15.11.1 (the bar is per chat).
    chatId: CHAT,
    operation: over.operation ?? "edit_file",
    status: over.status ?? "pending",
    ...over,
  } as QueuedOperation;
}

/**
 * Seed the queue BEFORE rendering. Setting it afterwards left the component
 * mounted against an empty queue, so the "stays hidden" cases passed without
 * proving anything — they were asserting the absence of a bar that had never
 * been given a reason to appear.
 */
function seed(ops: QueuedOperation[]) {
  getDefaultStore().set(
    permissionQueueAtom,
    new Map(ops.map((o) => [o.id, o])),
  );
  return renderWithProviders(<PendingApprovalsBar chatId={CHAT} />).store;
}

describe("PendingApprovalsBar", () => {
  beforeEach(() => {
    fakeIpc.executeAllPermissions.mockClear();
    fakeIpc.approveAllForTurn.mockClear();
  });
  afterEach(() => cleanup());

  it("stays hidden when nothing is pending", () => {
    seed([]);
    expect(screen.queryByText(/approval/i)).toBeNull();
  });

  /** Only PENDING counts — a queued/running op is already being dealt with. */
  it("stays hidden when the queue holds only non-pending operations", () => {
    seed([
      op({ id: "a", status: "running" }),
      op({ id: "b", status: "completed" }),
    ]);
    expect(screen.queryByRole("button", { name: /allow all/i })).toBeNull();
  });

  it("stays hidden for another chat's card (15.11.0: one chat's card showed in every chat)", () => {
    seed([op({ id: "elsewhere", path: "src/a.ts", chatId: CHAT - 1 })]);
    expect(screen.queryByRole("button", { name: /allow all/i })).toBeNull();
  });

  it("appears as soon as something is waiting", () => {
    seed([op({ id: "a", path: "src/a.ts" })]);
    expect(screen.getByRole("button", { name: /allow all/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  /**
   * Covers the rest of the TURN, not just what is queued.
   *
   * A one-shot drain read as "stop asking me" and behaved as "clear this batch":
   * the next command prompted again, so a turn full of first-token-dangerous
   * commands (curl, python3, jq) had to be approved one at a time. The bar now
   * calls the turn-scoped channel; the inline "Approve all files" button keeps the
   * one-shot behaviour, because a file batch is a bounded, visible set.
   */
  it("approves the rest of the turn, not just the current queue", () => {
    seed([
      op({ id: "a", path: "src/a.ts" }),
      op({ id: "b", path: "src/b.ts" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /allow all/i }));
    expect(fakeIpc.approveAllForTurn).toHaveBeenCalledWith({ chatId: CHAT });
    // Not the one-shot drain — that is what made it feel broken.
    expect(fakeIpc.executeAllPermissions).not.toHaveBeenCalled();
  });
});

describe("describePending — folder grants", () => {
  /**
   * A folder grant carries no `path` and is not a `run_command`, so it fell through
   * to the bare "1 approval waiting" — which says neither what is being asked nor
   * what clicking will do. That copy is why a grant card sat unnoticed for ten
   * minutes while the turn appeared to be working.
   */
  it("names the folder being granted", () => {
    expect(
      describePending([
        op({
          operation: "sandbox_escalation",
          sandboxGrantPath: "/Users/x/.atlarix/projects/demo/memory",
          sandboxGrantKind: "file",
        }),
      ]),
    ).toBe("Grant write access: /Users/x/.atlarix/projects/demo/memory");
  });

  it("falls back to the denied path when no grant path is given", () => {
    expect(
      describePending([
        op({
          operation: "sandbox_escalation",
          sandboxDeniedPath: "/Users/x/elsewhere/file.txt",
        }),
      ]),
    ).toContain("/Users/x/elsewhere/file.txt");
  });

  it("still says something useful with neither path", () => {
    const out = describePending([op({ operation: "sandbox_escalation" })]);
    expect(out).toMatch(/outside the workspace/i);
    expect(out).not.toBe("1 approval waiting");
  });

  it("counts grants in a mixed batch, so the breakdown adds up", () => {
    // Previously a grant was neither a file nor a command, so the total and its
    // own parenthetical disagreed.
    const out = describePending([
      op({ id: "a", path: "src/a.ts" }),
      op({ id: "b", operation: "run_command", command: "npm test" }),
      op({
        id: "c",
        operation: "sandbox_escalation",
        sandboxGrantPath: "/tmp/g",
      }),
    ]);
    expect(out).toContain("3 approvals waiting");
    expect(out).toContain("1 file");
    expect(out).toContain("1 command");
    expect(out).toContain("1 folder grant");
  });
});

describe("describePending", () => {
  /** One item names the actual target — a bare count would be less useful. */
  it("names a single file edit", () => {
    expect(describePending([op({ path: "src/auth.ts" })])).toBe(
      "Approve edit: src/auth.ts",
    );
  });

  it("names a single command", () => {
    expect(
      describePending([
        op({ operation: "run_command", command: "pnpm build" }),
      ]),
    ).toBe("Approve command: pnpm build");
  });

  it("counts and breaks down a mixed batch", () => {
    const text = describePending([
      op({ id: "a", path: "a.ts" }),
      op({ id: "b", path: "b.ts" }),
      op({ id: "c", operation: "run_command", command: "ls" }),
    ]);
    expect(text).toContain("3 approvals waiting");
    expect(text).toContain("2 files");
    expect(text).toContain("1 command");
  });
});
