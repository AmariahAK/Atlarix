/**
 * "Tell the AI?" has no default on purpose (AutomationForm), so Create stays
 * off until it is answered. Nothing said so: QA filled everything else in and
 * found the button dead (app QA, 2026-10-14).
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { AutomationForm } from "@/components/automations/AutomationForm";

describe("the automation form's Create button", () => {
  it("says what is missing while 'tell the AI?' is unanswered", () => {
    renderWithProviders(
      <AutomationForm workspaceId={1} existing={null} mcpServers={[]} open onClose={() => {}} onSaved={() => {}} />,
    );
    const create = screen.getByRole("button", { name: "Create automation" });
    expect(create).toBeDisabled();
    expect(screen.getByText("Choose whether to tell the AI.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/No — just tell me/));
    expect(screen.queryByText("Choose whether to tell the AI.")).toBeNull();
  });
});
