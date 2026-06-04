/**
 * v10 first-run wizard: shows for genuinely new users, steps through, and
 * "Skip setup" marks completion (never shown again).
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const navigateMock = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const updateSettingsMock = vi.fn(async () => ({}));
let settingsValue: Record<string, unknown> = {};
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: settingsValue,
    updateSettings: updateSettingsMock,
  }),
}));

vi.mock("@/hooks/useLoadApps", () => ({
  useLoadApps: () => ({ apps: [], loading: false, refreshApps: vi.fn() }),
}));

// Electron bridge used for legacy-marker + auth checks.
const invokeMock = vi.fn(async (channel: string) => {
  if (channel === "auth:get-current-user") return { user: null };
  if (channel === "onboarding:get-completed") return { completed: false };
  return {};
});
beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: {
      invoke: invokeMock,
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn(),
      removeAllListeners: vi.fn(),
    },
  };
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage variations */
  }
  navigateMock.mockClear();
  updateSettingsMock.mockClear();
});

import { FirstRunWizard } from "@/components/welcome/FirstRunWizard";

describe("FirstRunWizard", () => {
  it("shows for new users and steps through to providers", async () => {
    settingsValue = { firstRunWizardCompleted: false };
    renderWithProviders(<FirstRunWizard />);
    await waitFor(() => {
      expect(screen.getByTestId("first-run-wizard")).toBeInTheDocument();
    });
    expect(screen.getByText("Welcome to Atlarix")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Get started"));
    expect(screen.getByText("Models & providers")).toBeInTheDocument();
    // v10.1: MCP marketplace CTA on the providers step.
    expect(screen.getByText("MCP marketplace")).toBeInTheDocument();
  });

  it("Skip setup persists completion", async () => {
    settingsValue = { firstRunWizardCompleted: false };
    renderWithProviders(<FirstRunWizard />);
    await waitFor(() => screen.getByTestId("first-run-wizard"));
    fireEvent.click(screen.getByText("Skip setup"));
    await waitFor(() => {
      expect(updateSettingsMock).toHaveBeenCalledWith({
        firstRunWizardCompleted: true,
      });
    });
  });

  it("never renders for users who already completed it", async () => {
    settingsValue = { firstRunWizardCompleted: true };
    renderWithProviders(<FirstRunWizard />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("first-run-wizard")).not.toBeInTheDocument();
  });
});
