/**
 * The command approval card in the app and in VS Code opens with the agent's
 * reason, above the command, as plain text; without one the card is unchanged.
 * (Logic: src/__tests__/permission-reason.test.ts.)
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommandPermissionCard } from "@/components/chat/InlinePermissionApprovals";
import type { QueuedOperation } from "@/atoms/permissionQueueAtom";

vi.hoisted(() => {
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: () => {} });
});

import { addApproval, approvalDone, composer, initComposer } from "../../../packages/vscode/webview/chat/composer";

const REASON = "Can I check whether the PR has merge conflicts?";
const op: QueuedOperation = {
  id: "op-1",
  operation: "run_command",
  status: "pending",
  timestamp: 0,
  command: "gh pr view 12 --json mergeable",
  reason: REASON,
};
const card = (o: QueuedOperation) =>
  render(<CommandPermissionCard operation={o} appId={1} onOnce={() => {}} onAlways={() => {}} onDeny={() => {}} />);

describe("app: command approval card", () => {
  it("the reason comes first, then the command", () => {
    const { container } = card(op);
    const text = container.textContent ?? "";
    expect(screen.getByText(`Reason: ${REASON}`)).toBeTruthy();
    expect(text.indexOf(REASON)).toBeLessThan(text.indexOf("$ gh pr view 12 --json mergeable"));
  });

  it("markup in a reason is text, not markup", () => {
    const { container } = card({ ...op, reason: "Can I <b>run</b> it?" });
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("Can I <b>run</b> it?");
  });

  it("no reason: no reason line", () => {
    const { container } = card({ ...op, reason: undefined });
    expect(container.textContent).not.toContain("Reason:");
    expect(container.textContent).toContain("$ gh pr view 12 --json mergeable");
  });
});

describe("VS Code: approval bar", () => {
  beforeAll(() => initComposer({ open: vi.fn() }));
  const show = (reason: string | null) => {
    document.body.replaceChildren(composer);
    addApproval({
      requestId: "r1",
      toolCall: {
        toolCallId: "approval:op1",
        title: "Run gh pr view 12",
        _meta: { atlarix: { approval: { command: "gh pr view 12", intent: "Check mergeability", reason } } },
      } as never,
      options: [{ optionId: "once", name: "Yes", kind: "allow_once" }] as never,
      hasDiff: false,
    });
    const found = composer.querySelector(".approval .approval__reason");
    approvalDone("r1");
    return found;
  };

  it("the reason sits above the command, as text", () => {
    document.body.replaceChildren(composer);
    addApproval({
      requestId: "r2",
      toolCall: {
        toolCallId: "approval:op2",
        _meta: { atlarix: { approval: { command: "gh pr view 12", reason: "Can I <img src=x> check?" } } },
      } as never,
      options: [{ optionId: "once", name: "Yes", kind: "allow_once" }] as never,
      hasDiff: false,
    });
    const bar = composer.querySelector(".approval")!;
    const reason = bar.querySelector(".approval__reason");
    expect(reason?.textContent).toBe("Reason: Can I <img src=x> check?");
    expect(bar.querySelector("img")).toBeNull();
    const kids = [...bar.children];
    expect(kids.indexOf(reason!)).toBeLessThan(kids.indexOf(bar.querySelector(".approval__code")!));
    approvalDone("r2");
  });

  it("no reason: no reason line", () => {
    expect(show(null)).toBeNull();
  });
});
