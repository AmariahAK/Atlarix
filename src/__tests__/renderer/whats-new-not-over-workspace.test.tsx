/**
 * QA (app) #8: the "What's new" note stayed up after a workspace opened and
 * covered the composer — the model picker, the mode and the text box — until
 * its X was pressed. It is a footnote for the home screen; with a workspace open
 * it waits, undismissed, until you are back there.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";
import { selectedAppIdAtom } from "@/atoms/appAtoms";

const fakeIpc = Object.assign(makeFakeIpc(), {
  getWhatsNew: vi.fn(async () => ({ id: "n1", title: "Your keys and MCP servers", body: "Body.", link: null })),
  onWhatsNewChanged: vi.fn(() => () => {}),
});
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { WhatsNewPanel } from "@/components/WhatsNewPanel";

describe("the What's new note", () => {
  it("shows on the home screen", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, null);
    renderWithProviders(<WhatsNewPanel />);
    expect(await screen.findByText("Your keys and MCP servers")).toBeTruthy();
  });

  it("does not cover an open workspace", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, 39);
    renderWithProviders(<WhatsNewPanel />);
    await waitFor(() => expect(fakeIpc.getWhatsNew).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Your keys and MCP servers")).toBeNull();
  });
});
