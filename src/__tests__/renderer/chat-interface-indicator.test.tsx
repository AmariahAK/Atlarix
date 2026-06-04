/**
 * v10.1: the legacy /chat surface (ChatInterface) shows the inline compass
 * while thinking — not the old purple pulse dot.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { ChatInterface } from "@/components/ChatInterface";

describe("ChatInterface (legacy /chat surface)", () => {
  it("shows the compass indicator while thinking", () => {
    renderWithProviders(<ChatInterface messages={[]} isThinking />);
    const indicator = screen.getByTestId("legacy-thinking-indicator");
    expect(indicator).toBeInTheDocument();
    const compass = screen.getByTestId("atlarix-animation");
    expect(compass).toHaveAttribute("data-phase", "thinking");
    expect(compass).toHaveAttribute("data-size", "inline");
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("shows no indicator when idle", () => {
    renderWithProviders(<ChatInterface messages={[]} isThinking={false} />);
    expect(screen.queryByTestId("legacy-thinking-indicator")).not.toBeInTheDocument();
  });
});
