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
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
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

/**
 * Auth, as the wizard's gate now reads it.
 *
 * THIS MOCK IS THE POINT OF THE REGRESSION TEST BELOW. Production's
 * `onboarding:get-completed` returns `{ completed: true }` for a signed-out user
 * (`auth_handlers.ts:524`), and a brand-new user IS signed out when the gate runs.
 * Every case here therefore states its auth posture explicitly rather than
 * inheriting one, because "signed out" and "not answered yet" are different
 * answers that used to produce the same behaviour.
 */
let authValue: {
  isAuthenticated: boolean;
  authResolved: boolean;
  user: { id: string } | null;
} = { isAuthenticated: true, authResolved: true, user: { id: "u1" } };
vi.mock("@/lib/auth/useAuth", () => ({
  useAuth: () => authValue,
}));

// Electron bridge used for legacy-marker + auth checks.
const onboardingCompleted = { value: false };
const invokeMock = vi.fn(async (channel: string) => {
  if (channel === "auth:get-current-user") return { user: null };
  if (channel === "onboarding:get-completed")
    return { completed: onboardingCompleted.value };
  return {};
});
beforeEach(() => {
  authValue = { isAuthenticated: true, authResolved: true, user: { id: "u1" } };
  onboardingCompleted.value = false;
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

  /**
   * THE BUG THIS SUITE USED TO HIDE.
   *
   * `onboarding:get-completed` answers `{ completed: true }` when nobody is signed
   * in — "not logged in => no onboarding". The wizard read that as a legacy
   * completion marker, wrote `firstRunWizardCompleted: true`, and returned without
   * ever opening. Since a fresh install is ALWAYS signed out at the moment this
   * effect runs, the wizard completed itself unseen on first launch and no user
   * ever saw it.
   *
   * It also never reached `finish()`, so `onboarding:set-completed(true)` was never
   * sent and the Supabase flag stayed false — which is the flag `TourManager`
   * requires before it will start. One bug took out both onboarding surfaces.
   *
   * The old suite passed because it stubbed `{ completed: false }`, the one value
   * production cannot return for a signed-out user.
   */
  it("does NOT self-complete when signed out, even though onboarding reports completed", async () => {
    authValue = { isAuthenticated: false, authResolved: true, user: null };
    onboardingCompleted.value = true; // what production returns when signed out
    settingsValue = { firstRunWizardCompleted: false };

    renderWithProviders(<FirstRunWizard />);
    await new Promise((r) => setTimeout(r, 30));

    expect(screen.queryByTestId("first-run-wizard")).not.toBeInTheDocument();
    expect(updateSettingsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ firstRunWizardCompleted: true }),
    );
  });

  it("stays closed while auth is still resolving, then opens once signed in", async () => {
    authValue = { isAuthenticated: false, authResolved: false, user: null };
    settingsValue = { firstRunWizardCompleted: false };

    const { rerender } = renderWithProviders(<FirstRunWizard />);
    await new Promise((r) => setTimeout(r, 30));
    // `!isAuthenticated` during launch means "no answer yet", not "signed out".
    expect(screen.queryByTestId("first-run-wizard")).not.toBeInTheDocument();
    expect(updateSettingsMock).not.toHaveBeenCalled();

    authValue = {
      isAuthenticated: true,
      authResolved: true,
      user: { id: "u1" },
    };
    rerender(<FirstRunWizard />);
    await waitFor(() => {
      expect(screen.getByTestId("first-run-wizard")).toBeInTheDocument();
    });
  });

  it("Open Settings navigates WITHOUT marking the wizard complete", async () => {
    settingsValue = { firstRunWizardCompleted: false };
    renderWithProviders(<FirstRunWizard />);
    await waitFor(() => screen.getByTestId("first-run-wizard"));
    fireEvent.click(screen.getByText("Get started"));

    fireEvent.click(screen.getByText("Open Settings → AI"));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/settings" }),
      );
    });
    // The hole that skipped the model step for exactly the BYOK user: this
    // button used to call finish(), completing the wizard on the way out.
    expect(updateSettingsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ firstRunWizardCompleted: true }),
    );
  });
});
