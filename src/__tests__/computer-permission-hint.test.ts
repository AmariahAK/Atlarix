/**
 * Missing macOS grants must be NAMED, not inferred from a downstream symptom.
 *
 * From a real packaged run on 2026-09-05, driving WhatsApp with Screen Recording
 * ungranted. The model was told, verbatim:
 *
 *     cannot read /var/folders/…/atlarix-ocr-GobYxw/window.png:
 *     No such file or directory (os error 2)
 *
 * True, and useless. Nothing in it names a permission, so the model could not ask
 * for the one thing that would fix it: it retried, tried another app, shelled out
 * to `screencapture`, and finally hit the terminal refusal — four turns spent
 * routing around a dialog nobody was ever asked to click.
 *
 * The preflight knew the whole time. It backed the settings panel and the doctor
 * row and was never consulted when an OPERATION failed. A permission check that
 * only runs where things are already going well is not a permission check.
 *
 * The trap underneath, and the reason a thrown error was never going to be enough:
 * `get_window_state` SUCCEEDS with Screen Recording denied. It returns real
 * `window_bounds` and `screenshot_scale` from the window server — neither needs a
 * grant — and silently writes no image. The only evidence is a file that is not
 * there, so callers must check for the ARTEFACT, not for an exception.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

let permissions = {
  platform: "darwin",
  accessibility: "granted",
  screenRecording: "granted",
  needsRelaunch: false,
};

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => "/tmp" },
}));

vi.mock("@/main/computer-use-permissions", () => ({
  readPermissions: () => permissions,
}));

import { missingGrantMessage, RETRY_AFTER_GRANT } from "@/lib/computer/permission-hint";

beforeEach(() => {
  permissions = {
    platform: "darwin",
    accessibility: "granted",
    screenRecording: "granted",
    needsRelaunch: false,
  };
});

describe("missingGrantMessage", () => {
  it("says nothing when the grant is held", () => {
    expect(missingGrantMessage("accessibility")).toBeNull();
    expect(missingGrantMessage("screen")).toBeNull();
  });

  it("names Accessibility, the pane, and the in-app shortcut", () => {
    permissions.accessibility = "denied";
    const m = missingGrantMessage("accessibility");
    expect(m).toMatch(/Accessibility/);
    expect(m).toMatch(/System Settings/);
    // A user who cannot find the pane is no better off than one who was told
    // "no such file or directory".
    expect(m).toMatch(/Settings → Computer use/);
  });

  it("tells the user to RESTART for Screen Recording — the per-process cache", () => {
    permissions.screenRecording = "denied";
    const m = missingGrantMessage("screen");
    // macOS caches the screen-capture decision per process. Without this line the
    // user grants it, nothing changes, and the feature looks broken.
    expect(m).toMatch(/RESTART/);
    // And it must say what still works, so the model degrades instead of stopping.
    expect(m).toMatch(/mode:"tree"/);
  });

  it("uses the category-2 tail — retryable ONCE, after the user acts", () => {
    permissions.accessibility = "denied";
    permissions.screenRecording = "denied";
    for (const need of ["accessibility", "screen"] as const) {
      expect(missingGrantMessage(need)).toContain(RETRY_AFTER_GRANT);
    }
  });

  it("does NOT use a permanent-limitation or policy-refusal tail", () => {
    // The distinction IS the behaviour: an agent told "do not retry" stops, and one
    // told "failed" retries forever. A grant is neither — it is one user action away.
    permissions.accessibility = "denied";
    const m = missingGrantMessage("accessibility")!;
    expect(m).not.toMatch(/platform limitation/i);
    expect(m).not.toMatch(/Atlarix will not do this/i);
  });

  it("treats not-determined as missing, not as granted", () => {
    // "Never asked" and "said no" are the same thing to an operation that needs it.
    permissions.screenRecording = "not-determined";
    expect(missingGrantMessage("screen")).toMatch(/Screen Recording/);
  });

  it("stays silent on Windows and Linux, where there is no such permission", () => {
    // Sending a Windows user to a System Settings pane that has no such entry
    // would be worse than the raw error.
    permissions = {
      platform: "win32",
      accessibility: "unsupported",
      screenRecording: "unsupported",
      needsRelaunch: false,
    };
    expect(missingGrantMessage("accessibility")).toBeNull();
    expect(missingGrantMessage("screen")).toBeNull();
  });

  it("reads live state every call, so a grant given mid-session takes effect", () => {
    permissions.accessibility = "denied";
    expect(missingGrantMessage("accessibility")).not.toBeNull();
    // A cached "denied" would keep refusing after the user had already fixed it,
    // which reads exactly like the feature being broken.
    permissions.accessibility = "granted";
    expect(missingGrantMessage("accessibility")).toBeNull();
  });
});
