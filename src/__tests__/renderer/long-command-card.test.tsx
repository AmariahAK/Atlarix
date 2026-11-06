/**
 * A long command must not push a card's buttons out of reach.
 *
 * be4999bd capped the command block on the risky-command card (a pasted shell
 * script hid Approve/Deny). The sandbox "grant write access" card shows the same
 * command and was left uncapped, so a long blocked command there still hid
 * Allow/Deny. Both cards now share one block; jsdom has no layout, so this checks
 * the block that holds the command scrolls instead of growing.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CommandPermissionCard, SandboxEscalationCard } from "@/components/chat/InlinePermissionApprovals";
import type { QueuedOperation } from "@/atoms/permissionQueueAtom";

const longCommand = Array.from({ length: 80 }, (_, i) => `echo line-${i}`).join(" && ");
const noop = () => {};

function commandBlock(): HTMLElement {
  return screen.getByText((_, el) => el?.tagName === "DIV" && el.textContent === `$ ${longCommand}`);
}

function expectScrolls(el: HTMLElement) {
  expect(el.className).toMatch(/\bmax-h-40\b/);
  expect(el.className).toMatch(/\boverflow-y-auto\b/);
}

describe("long command in a permission card", () => {
  it("scrolls on the run-command card", () => {
    const op: QueuedOperation = { id: "c1", operation: "run_command", status: "pending", timestamp: 0, command: longCommand };
    render(<CommandPermissionCard operation={op} appId={1} onOnce={noop} onAlways={noop} onDeny={noop} />);
    expectScrolls(commandBlock());
  });

  it("scrolls on the sandbox grant card", () => {
    const op: QueuedOperation = {
      id: "s1",
      operation: "sandbox_escalation",
      status: "pending",
      timestamp: 0,
      command: longCommand,
      sandboxDeniedPath: "/tmp/out",
      sandboxGrantPath: "/tmp",
    };
    render(<SandboxEscalationCard operation={op} onAllow={noop} onDeny={noop} />);
    expectScrolls(commandBlock());
    expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  });
});
