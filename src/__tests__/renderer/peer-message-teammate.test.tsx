/**
 * A message from another Atlarix session is a TEAMMATE's (owner): it reads as
 * one, never as the user's own words, and it is never the user's to edit and
 * resend. The CLI and the editor do the same (src/cli/agent/own-messages.ts).
 *
 * A row can hold both — queued messages are joined into one turn when an idle
 * chat wakes — and then the user's part is still theirs: drawn as their bubble,
 * not folded into the teammate's card on the agent's side.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { SimpleMessage } from "@/components/SimpleMessage";
import type { Message } from "@/ipc/ipc_types";

const peer = (from: string, text: string, surface = "cli") =>
  `<atlarix-peer-message from="${from}" reply-to="s9" surface="${surface}" workspace="/w">\n${text}\n</atlarix-peer-message>`;

function userRow(content: string): Message {
  return {
    id: 51,
    role: "user",
    content,
    approvalState: null,
    commitHash: null,
  } as unknown as Message;
}

function render(content: string) {
  return renderWithProviders(
    <SimpleMessage message={userRow(content)} chatId={7} onEditUserMessage={async () => {}} />,
  );
}

describe("a teammate's message in the app", () => {
  it("is labelled a teammate's, with its session and surface", () => {
    render(peer("Release prep", "Please don't touch package.json"));
    expect(
      screen.getByText((_, el) => el?.tagName === "BUTTON" && el.textContent === "Message from Release prep (CLI)"),
    ).toBeTruthy();
  });

  it("a long one is never just a label: its preview shows in the row, a click shows all of it", () => {
    const long = `ai-4b:\n\n${"Phase 2 is ready for review with every test green. ".repeat(20)}\nLast line.`;
    render(peer("ai-4b", long));
    const row = screen.getByRole("button", { expanded: false });
    expect(row.textContent).toContain("Message from ai-4b (CLI)");
    expect(row.textContent).toContain("ai-4b: Phase 2 is ready for review");
    expect(screen.queryByText(/Last line\./)).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText(/Last line\./)).toBeTruthy();
  });

  it("has no Edit, and is not drawn as the user's bubble", () => {
    const { container } = render(peer("Release prep", "Please don't touch package.json"));
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
    expect(container.querySelector(".bg-user-bubble")).toBeNull();
  });

  it("in a mixed row, only the user's own words are drawn as theirs", () => {
    const { container } = render(`${peer("Docs", "FYI the README moved")}\n\nand add a test`);
    const bubbles = [...container.querySelectorAll(".bg-user-bubble")];
    expect(bubbles.map((b) => b.textContent?.trim())).toEqual(["and add a test"]);
    // Editing would rewrite the whole row and drop the teammate's message.
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });

  it("a plain message of the user's still has Edit (control)", () => {
    render("fix the login bug");
    expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
  });
});
