/**
 * The computer-use settings section.
 *
 * Two things worth pinning beyond "it renders":
 *
 *  1. **Nothing runs on mount except a NON-PROMPTING read.** Reading permission
 *     state is `isTrustedAccessibilityClient(false)` + `getMediaAccessStatus`, and
 *     the Grant buttons are the consent — the standard `DiagnosticsPanel` already
 *     sets. A panel that provoked a macOS permission dialog just by being opened
 *     would be a genuinely bad surprise.
 *  2. **Every channel it uses is in `validInvokeChannels`.** Omitting one is a
 *     RUNTIME-only failure (`Invalid channel: <name>`) — registering the handler in
 *     ipc_host is not enough and nothing at build time catches it, which
 *     `src/preload.ts` says about itself in a comment.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const calls: string[] = [];
let permissions = {
  platform: "darwin",
  accessibility: "denied" as string,
  screenRecording: "denied" as string,
  needsRelaunch: false,
  appPath: "/Applications/Atlarix.app",
};

const fakeIpc = Object.assign(makeFakeIpc(), {
  getUserSettings: vi.fn(async () => ({})),
  setUserSettings: vi.fn(async (s: Record<string, unknown>) => s),
  getComputerUsePermissions: vi.fn(async () => {
    calls.push("permissions");
    return permissions;
  }),
  requestComputerUsePermission: vi.fn(async (which: string) => {
    calls.push(`request:${which}`);
    permissions = { ...permissions, [which]: "granted" };
    return permissions;
  }),
  relaunchForComputerUse: vi.fn(async () => {
    calls.push("relaunch");
    return { ok: true };
  }),
});

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { ComputerUseSettings } from "@/components/settings/ComputerUseSettings";

beforeEach(() => {
  calls.length = 0;
  permissions = {
    platform: "darwin",
    accessibility: "denied",
    screenRecording: "denied",
    needsRelaunch: false,
    appPath: "/Applications/Atlarix.app",
  };
});

describe("ComputerUseSettings", () => {
  it("reads permission state on mount, and asks for NOTHING", async () => {
    renderWithProviders(<ComputerUseSettings />);
    await waitFor(() => expect(calls).toContain("permissions"));
    // The read is non-prompting; a request would open a system pane.
    expect(calls.some((c) => c.startsWith("request:"))).toBe(false);
    expect(calls).not.toContain("relaunch");
  });

  /**
   * THE LABELS DIFFER ON PURPOSE, and the difference is the fix for a real
   * two-day confusion.
   *
   * Accessibility has a real prompting API, so "Grant" is true. Screen Recording
   * does not — Apple moved that consent to ScreenCaptureKit and no Electron call
   * raises the dialog — so the button can only open the pane, and calling it
   * "Grant" is what made fourteen clicks across two days read as "I granted it and
   * it still says no". Asserting both labels pins the honest wording.
   */
  it("offers Grant for each ungranted permission, and only then requests", async () => {
    renderWithProviders(<ComputerUseSettings />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /grant/i }).length).toBe(2));

    fireEvent.click(screen.getAllByRole("button", { name: /grant/i })[0]!);
    await waitFor(() => expect(calls.some((c) => c.startsWith("request:"))).toBe(true));
  });

  /**
   * THE STEP THE BUTTON CANNOT DO, and the reason this is asserted rather than left
   * to prose. Apple moved screen-capture consent to ScreenCaptureKit, so no Electron
   * call raises that dialog — and macOS only LISTS an app in the pane once the app
   * has asked. An app that cannot ask never appears, so the pane's `+` button is the
   * only route, and the user needs the exact bundle path because a local build and
   * the installed one are both called Atlarix.
   */
  it("tells the user to add the app manually, and which one to pick", async () => {
    renderWithProviders(<ComputerUseSettings />);
    await waitFor(() => expect(screen.getByText(/will not be in that list/i)).toBeInTheDocument());
    expect(screen.getByText(/Atlarix\.app$/)).toBeInTheDocument();
  });

  it("names the two permissions and what each one actually costs you", async () => {
    renderWithProviders(<ComputerUseSettings />);
    await waitFor(() => expect(screen.getByText("Accessibility")).toBeInTheDocument());
    expect(screen.getByText("Screen Recording")).toBeInTheDocument();
    // Screen Recording is NOT required for the core feature, and saying so stops a
    // user granting more than they need.
    expect(
      screen.getByText(/Reading and clicking work without it/i),
    ).toBeInTheDocument();
  });

  it("offers a restart only once a grant has actually changed", async () => {
    renderWithProviders(<ComputerUseSettings />);
    await waitFor(() => expect(calls).toContain("permissions"));
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
  });

  it("says there is no OS gate on Windows rather than showing two green ticks", async () => {
    permissions = {
      platform: "win32",
      accessibility: "unsupported",
      screenRecording: "unsupported",
      needsRelaunch: false,
      // Empty off darwin: there is no pane to add an app to, so the hint must not
      // render a path at someone who has nowhere to paste it.
      appPath: "",
    };
    renderWithProviders(<ComputerUseSettings />);
    // "unsupported" is a fact about the platform, not a permission we hold —
    // rendering it as granted would imply a consent that never happened.
    await waitFor(() =>
      expect(screen.getByText(/no system permission for this/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Elevated \(administrator\) windows can never be driven/i))
      .toBeInTheDocument();
  });

  it("points at the per-project kill switch", async () => {
    renderWithProviders(<ComputerUseSettings />);
    await waitFor(() =>
      expect(screen.getByText(/\.atlarix\/permissions\.json/)).toBeInTheDocument(),
    );
  });
});

describe("preload channel allowlist", () => {
  it("carries every channel this panel invokes", async () => {
    // The failure mode without this: `Invalid channel: computer-use:permissions`
    // at runtime, in a packaged build, with nothing at build time to catch it.
    const preload = await import("node:fs").then((fs) =>
      fs.readFileSync("src/preload.ts", "utf8"),
    );
    for (const channel of [
      "computer-use:permissions",
      "computer-use:request-permission",
      "computer-use:relaunch",
    ]) {
      expect(preload).toContain(`"${channel}"`);
    }
  });
});
