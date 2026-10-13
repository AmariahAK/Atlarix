/**
 * QA (app) #44: closing "Where did you hear about Atlarix?" with X stored
 * nothing, so it came back every launch (once over the approval card and the
 * composer). X now remembers it for the account; no answer is sent.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const { state } = vi.hoisted(() => ({
  state: { userId: "", settings: {} as Record<string, unknown>, updateSettings: vi.fn(async () => ({})) },
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: state.settings, refreshSettings: vi.fn(), updateSettings: state.updateSettings }),
}));
vi.mock("@/lib/auth/useAuth", () => ({ useAuth: () => ({ user: { id: state.userId } }) }));
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => ({ recordPeerPushPrompt: vi.fn() }) } }));
vi.mock("@/components/community/AcquisitionSourceQuestion", () => ({ AcquisitionSourceQuestion: () => <div>question</div> }));

import { CommunityPrompts } from "@/components/community/CommunityPrompts";

describe("the 'where did you hear' card", () => {
  it("isn't asked again of an account that closed it", () => {
    state.userId = "u-closed";
    state.settings = { acquisitionPromptDismissedFor: "u-closed" };
    render(<CommunityPrompts />);
    expect(screen.queryByText("question")).toBeNull();
  });

  it("X remembers it for the account, and sends no answer", async () => {
    state.userId = "u-new";
    state.settings = {};
    render(<CommunityPrompts />);
    expect(screen.getByText("question")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /dismiss|close/i })));
    expect(state.updateSettings).toHaveBeenCalledWith({ acquisitionPromptDismissedFor: "u-new" });
    expect(screen.queryByText("question")).toBeNull();
  });
});
