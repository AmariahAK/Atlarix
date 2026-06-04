/**
 * v10.1 Cmd/Ctrl+P quick file open: opens on the chord, fuzzy-lists workspace
 * files from the shared app-files query, and opens the pick in the Code tab.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import {
  previewTabAtom,
  rightPanelVisibleAtom,
  selectedErrorForCodeAtom,
} from "@/atoms/sourceAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { QuickFileOpen } from "@/components/QuickFileOpen";

const APP_ID = 5;

function pressCmdP() {
  // jsdom's navigator.platform isn't mac, so the chord resolves to Ctrl+P.
  fireEvent.keyDown(document, { key: "p", ctrlKey: true });
}

describe("QuickFileOpen", () => {
  beforeEach(() => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, APP_ID);
    store.set(selectedErrorForCodeAtom, null);
    store.set(rightPanelVisibleAtom, false);
    fakeIpc.getAppFiles.mockResolvedValue({
      files: ["src/auth.ts", "src/components/App.tsx", "README.md"],
      pathExists: true,
    });
  });

  it("opens on Cmd+P and lists workspace files", async () => {
    renderWithProviders(<QuickFileOpen />);
    act(() => pressCmdP());
    await waitFor(() => {
      expect(screen.getByText("auth.ts")).toBeInTheDocument();
    });
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("fuzzy filters by basename", async () => {
    renderWithProviders(<QuickFileOpen />);
    act(() => pressCmdP());
    await waitFor(() => screen.getByTestId("quick-file-open-input"));
    fireEvent.change(screen.getByTestId("quick-file-open-input"), {
      target: { value: "auth" },
    });
    await waitFor(() => {
      expect(screen.getByText("auth.ts")).toBeInTheDocument();
    });
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("selecting a file opens it in the right-panel Code tab", async () => {
    const { store } = renderWithProviders(<QuickFileOpen />);
    act(() => pressCmdP());
    await waitFor(() => screen.getByText("auth.ts"));
    fireEvent.click(screen.getByText("auth.ts"));
    await waitFor(() => {
      expect(store.get(selectedErrorForCodeAtom)).toEqual({
        filePath: "src/auth.ts",
      });
    });
    expect(store.get(rightPanelVisibleAtom)).toBe(true);
    expect(store.get(previewTabAtom)).toBe("code");
  });

  it("renders nothing without a workspace", () => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, null);
    const { container } = renderWithProviders(<QuickFileOpen />);
    act(() => pressCmdP());
    expect(container.querySelector("[data-testid=quick-file-open-input]")).toBeNull();
  });
});
