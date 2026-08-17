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
};
fakeIpc.executeAllPermissions = vi.fn(async () => []);
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
  getDefaultStore().set(permissionQueueAtom, new Map(ops.map((o) => [o.id, o])));
  return renderWithProviders(<PendingApprovalsBar chatId={CHAT} />).store;
}

describe("PendingApprovalsBar", () => {
  beforeEach(() => {
    fakeIpc.executeAllPermissions.mockClear();
  });
  afterEach(() => cleanup());

  it("stays hidden when nothing is pending", () => {
    seed([]);
    expect(screen.queryByText(/approval/i)).toBeNull();
  });

  /** Only PENDING counts — a queued/running op is already being dealt with. */
  it("stays hidden when the queue holds only non-pending operations", () => {
    seed([op({ id: "a", status: "running" }), op({ id: "b", status: "completed" })]);
    expect(screen.queryByRole("button", { name: "Approve all" })).toBeNull();
  });

  it("appears as soon as something is waiting", () => {
    seed([op({ id: "a", path: "src/a.ts" })]);
    expect(screen.getByRole("button", { name: "Approve all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("approves the batch through the same one-shot channel as the inline button", () => {
    seed([op({ id: "a", path: "src/a.ts" }), op({ id: "b", path: "src/b.ts" })]);
    fireEvent.click(screen.getByRole("button", { name: "Approve all" }));
    expect(fakeIpc.executeAllPermissions).toHaveBeenCalledWith({ chatId: CHAT });
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
      describePending([op({ operation: "run_command", command: "pnpm build" })]),
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
