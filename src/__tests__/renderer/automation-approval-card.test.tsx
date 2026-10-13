/**
 * The automation approval card states the two facts that decide unattended spend.
 *
 * WHY A RENDER TEST
 * -----------------
 * `automation_write` is a NEW permission operation, and the approvals component
 * routes anything it does not recognise into `FilePermissionCard` — so without a
 * branch of its own an automation would have rendered as a file operation:
 * plausible-looking, wrong, and silent. Same shape as the documented
 * "Runned <tool>" trap, where a missing branch produced a card that looked fine
 * and said nothing useful.
 *
 * The assertions are about MEANING, not markup: whether the user is told that
 * this runs on its own, whether it will wake the AI, and whether it will spend a
 * model turn per fire. A name like "CI failures on main" carries none of that.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutomationPermissionCard } from "@/components/chat/InlinePermissionApprovals";
import type { QueuedOperation } from "@/atoms/permissionQueueAtom";

function renderWithOps(ops: QueuedOperation[]) {
  // The card is pure presentation — the surrounding component reads its queue
  // from a jotai atom, which is not what these assertions are about.
  return render(
    <>
      {ops.map((op) => (
        <AutomationPermissionCard
          key={op.id}
          operation={op}
          onAllow={() => {}}
          onDeny={() => {}}
        />
      ))}
    </>,
  );
}

const base: QueuedOperation = {
  id: "op-1",
  operation: "automation_write",
  status: "pending",
  timestamp: 0,
  automationAction: "create",
  automationName: "CI failures on main",
  automationTrigger: "on ci-failed in acme/app, polled every 15 min",
  automationRunMode: "notify-only",
  automationNotifyAgent: true,
};

describe("automation approval card", () => {
  it("says it runs on its own, and that the AI will be told", () => {
    renderWithOps([base]);
    expect(screen.getByText(/Create automation/i)).toBeTruthy();
    expect(screen.getByText(/Runs on its own/i)).toBeTruthy();
    expect(screen.getByText(/Atlarix reads them with your next message in this folder/i)).toBeTruthy();
  });

  it("says explicitly when the AI will NOT be woken, and why that matters", () => {
    renderWithOps([{ ...base, id: "op-2", automationNotifyAgent: false }]);
    expect(screen.getByText(/can't spend tokens/i)).toBeTruthy();
  });

  it("warns that a read-only automation costs a model turn per fire", () => {
    renderWithOps([{ ...base, id: "op-3", automationRunMode: "read-only" }]);
    expect(screen.getByText(/costs one turn per fire/i)).toBeTruthy();
  });

  it("surfaces the standing MCP consent an MCP trigger records", () => {
    // The poller runs unattended and cannot prompt, so consent is granted at
    // save time — a consequence the user should see before approving, not after.
    renderWithOps([
      { ...base, id: "op-4", automationGrantsMcpConsent: "slack_search" },
    ]);
    expect(screen.getByText(/standing consent/i)).toBeTruthy();
    expect(screen.getByText(/slack_search/)).toBeTruthy();
  });

  it("shows a was → now delta on an update instead of just a name", () => {
    renderWithOps([
      {
        ...base,
        id: "op-5",
        automationAction: "update",
        automationChanges: ["notifyAgent: false → true"],
      },
    ]);
    expect(screen.getByText(/Update automation/i)).toBeTruthy();
    expect(screen.getByText(/notifyAgent: false → true/)).toBeTruthy();
  });

  it("does not offer run-mode reassurances when deleting", () => {
    renderWithOps([{ ...base, id: "op-6", automationAction: "delete" }]);
    expect(screen.getByText(/Delete automation/i)).toBeTruthy();
    expect(screen.queryByText(/Atlarix reads them with your next message in this folder/i)).toBeNull();
  });
});
