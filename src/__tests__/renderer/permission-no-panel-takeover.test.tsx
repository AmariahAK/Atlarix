/**
 * A permission request must not seize the right panel.
 *
 * Same class of bug as `plan-restore-no-takeover`, and reported the same way:
 * during a browser/localhost task the panel kept reopening, showing nothing, and
 * closing it never stuck — "it said the thing is at 0".
 *
 * Two things were wrong. `setRightPanelVisible(true)` sat OUTSIDE the
 * `setPendingProposals` updater, so it fired even when the updater had
 * early-returned having added nothing — which is every redelivered permission,
 * and every operation the payload converter yields no proposals for
 * (`batch_plan`, `automation_write`, `revert_project_snapshot`: no `path`, and
 * not `run_command`).
 *
 * And the panel could not have helped anyway: `RightPanel` filters "permissions"
 * out of its tab list, because approvals moved inline to
 * `InlinePermissionApprovals` + `PendingApprovalsBar`. It was opening a surface
 * that cannot render the thing it was opening for.
 *
 * These pin both halves: the panel is left alone, and the proposals still land
 * for `useWorkspacePlanPanel`, which is a live reader of that atom.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getDefaultStore } from "jotai";
import { makeFakeIpc, type PermissionRequestPayload } from "./helpers";
import {
  rightPanelVisibleAtom,
  pendingProposalsAtom,
  previewTabAtom,
} from "@/atoms/sourceAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const { useStreamChat } = await import("@/hooks/useStreamChat");

const CHAT = -77;

/**
 * The permission listener is registered INSIDE `streamMessage`, not on mount —
 * so a test that only mounts the hook registers nothing and every assertion
 * below passes vacuously. The send is what arms it.
 */
let send: ((p: { prompt: string; chatId: number }) => Promise<void>) | null =
  null;

function Host() {
  const { streamMessage } = useStreamChat({ hasChatId: true });
  send = streamMessage as typeof send extends null
    ? never
    : NonNullable<typeof send>;
  return null;
}

function mountHost() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Host />
    </QueryClientProvider>,
  );
}

/** Mount, then send — which is what registers the permission listener. */
async function armed() {
  mountHost();
  await act(async () => {
    await send?.({ prompt: "hi", chatId: CHAT });
  });
}

const permission = (
  operation: string,
  preview: unknown,
  operationId = "op-1",
): PermissionRequestPayload => ({
  chatId: CHAT,
  type: "permission-request",
  operationId,
  request: { __permission_required: true, operation, preview },
});

describe("a permission request does not open the right panel", () => {
  const store = getDefaultStore();

  beforeEach(() => {
    // The hook subscribes per selected chat; without this it never registers a
    // permission listener and every assertion below would pass vacuously.
    store.set(selectedChatIdAtom, CHAT);
    store.set(rightPanelVisibleAtom, false);
    store.set(pendingProposalsAtom, []);
    store.set(previewTabAtom, "browser");
  });

  afterEach(() => cleanup());

  it("leaves the panel closed for an operation that yields no proposals", async () => {
    // `automation_write` has no `path` and is not `run_command`, so the
    // converter produces an empty proposal list — the case that reopened an
    // empty panel on every event.
    await armed();
    await act(async () => {
      fakeIpc.emitPermissionRequest(
        permission("automation_write", { name: "nightly", cron: "0 3 * * *" }),
      );
    });
    expect(store.get(rightPanelVisibleAtom)).toBe(false);
  });

  it("leaves the panel closed for a real file approval too", async () => {
    // Approvals render inline now, so even a well-formed proposal must not take
    // the panel. This is the half that would regress if someone "restored" the
    // old force-open on the grounds that approvals must not be missed.
    await armed();
    await act(async () => {
      fakeIpc.emitPermissionRequest(
        permission("edit_file", {
          path: "src/a.ts",
          type: "update",
          content: "x",
        }),
      );
    });
    expect(store.get(rightPanelVisibleAtom)).toBe(false);
  });

  it("still records the proposal, because useWorkspacePlanPanel reads it", async () => {
    await armed();
    await act(async () => {
      fakeIpc.emitPermissionRequest(
        permission("edit_file", {
          path: "src/a.ts",
          type: "update",
          content: "x",
        }),
      );
    });
    const proposals = store.get(pendingProposalsAtom);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.path).toBe("src/a.ts");
  });

  it("does not re-add a redelivered operation", async () => {
    // GitHub-style redelivery of the same operationId. Before the fix this was
    // the loudest case: nothing new to add, and the panel opened anyway.
    await armed();
    const payload = permission(
      "edit_file",
      { path: "src/a.ts", type: "update", content: "x" },
      "same-op",
    );
    await act(async () => {
      fakeIpc.emitPermissionRequest(payload);
      fakeIpc.emitPermissionRequest(payload);
    });
    expect(store.get(pendingProposalsAtom)).toHaveLength(1);
    expect(store.get(rightPanelVisibleAtom)).toBe(false);
  });

  it("does not switch the panel to a tab that no longer renders", async () => {
    // RightPanel filters "permissions" out of its tab list; selecting it would
    // leave the panel on a tab with nothing behind it.
    await armed();
    await act(async () => {
      fakeIpc.emitPermissionRequest(
        permission("edit_file", {
          path: "src/a.ts",
          type: "update",
          content: "x",
        }),
      );
    });
    expect(store.get(previewTabAtom)).not.toBe("permissions");
  });
});
