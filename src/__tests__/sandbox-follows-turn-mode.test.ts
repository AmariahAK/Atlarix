import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The command sandbox must follow the mode of the TURN that issued the command,
 * never the app's current global setting.
 *
 * The bug: `buildRunCommandSandbox` re-derived the work mode from
 * `readSettings()`. `workModePreference` / `selectedChatMode` are ONE app-wide
 * value, so opening a second window in Ask/Explore flipped a first window's
 * in-flight Build turn to a read-only sandbox mid-command. Observed as:
 *
 *   error: cannot lock ref 'HEAD': Unable to create '.git/HEAD.lock':
 *          Operation not permitted
 *   Writable roots for this run: (none)
 *
 * — while that window's UI still said Build, because settings changes are not
 * broadcast between windows.
 *
 * The existing `sandbox-readonly-profile.test.ts` passes `readOnly: true` as a
 * literal into `wrapCommandInSandbox`, so it exercises the profile SHAPE and
 * could never have caught this. These tests reach `buildRunCommandSandbox`
 * itself, with global settings deliberately set to the OPPOSITE of the turn's
 * mode — the only arrangement that actually pins the fix.
 */

/** Mutable stand-in for the global user-settings file. */
let globalSettings: Record<string, unknown> = {};

vi.mock("@/main/settings", () => ({
  readSettings: () => globalSettings,
  writeSettings: (s: Record<string, unknown>) => {
    globalSettings = { ...globalSettings, ...s };
  },
}));

vi.mock("@/lib/file-permissions-store", () => ({
  listSandboxWritablePaths: () => [],
  upsertSandboxWritablePath: () => {},
  revokeSandboxWritablePath: () => false,
  listWorkspaceFilePermissions: () => [],
  upsertWorkspaceFilePermission: () => {},
  revokeWorkspaceFilePermission: () => false,
}));

import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";
import type { WorkMode } from "@/lib/schemas";

const APP_ID = 91;
const tmpRoots: string[] = [];

function makeWorkspace(): string {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-turnmode-")),
  );
  tmpRoots.push(base);
  const ws = path.join(base, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}

/** Reach the private builder the same way the other interceptor tests do. */
function sandboxFor(
  ws: string,
  turnWorkMode?: WorkMode,
  preview?: { readOnly?: boolean },
) {
  const i = new PermissionInterceptor(
    ws,
    APP_ID,
    undefined,
    1,
    turnWorkMode,
  ) as unknown as {
    buildRunCommandSandbox: (
      preview?: unknown,
    ) => { readOnly?: boolean; enforce?: boolean } | undefined;
  };
  return i.buildRunCommandSandbox(preview);
}

afterEach(() => {
  globalSettings = {};
  for (const d of tmpRoots.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("command sandbox follows the turn's work mode", () => {
  it("a Build turn stays writable when global settings say ask (the reported bug)", () => {
    const ws = makeWorkspace();
    // Another window switched the app to Explore mid-turn.
    globalSettings = {
      workModePreference: "ask",
      selectedChatMode: "ask",
      intentMode: "ask",
    };

    const sandbox = sandboxFor(ws, "build");

    expect(sandbox).toBeDefined();
    expect(sandbox?.readOnly).toBe(false);
  });

  it("a debug turn stays writable when global settings say plan", () => {
    const ws = makeWorkspace();
    globalSettings = {
      workModePreference: "plan",
      selectedChatMode: "ask",
      intentMode: "ask",
    };

    expect(sandboxFor(ws, "debug")?.readOnly).toBe(false);
  });

  it("an Explore turn stays read-only when global settings say build", () => {
    const ws = makeWorkspace();
    // The inverse leak: a Build window must not widen a read-only turn. This is
    // the automation case — unattended runs pass workModeOverride:"ask" while
    // the user's saved preference is Build.
    globalSettings = {
      workModePreference: "build",
      selectedChatMode: "build",
      intentMode: "build",
    };

    expect(sandboxFor(ws, "ask")?.readOnly).toBe(true);
  });

  it.each(["plan", "review"] as const)(
    "%s is read-only regardless of global settings",
    (mode) => {
      const ws = makeWorkspace();
      globalSettings = {
        workModePreference: "build",
        selectedChatMode: "build",
        intentMode: "build",
      };

      expect(sandboxFor(ws, mode)?.readOnly).toBe(true);
    },
  );

  it("falls back to global settings when no turn mode is supplied", () => {
    // Legacy constructions (tests, any caller predating the 5th parameter) must
    // keep their old behaviour rather than silently becoming writable.
    const ws = makeWorkspace();
    globalSettings = {
      workModePreference: "ask",
      selectedChatMode: "ask",
      intentMode: "ask",
    };

    expect(sandboxFor(ws, undefined)?.readOnly).toBe(true);
  });

  it("genuinely global sandbox settings are still honoured", () => {
    // Only the mode moved to the turn; `sandboxRunCommand: false` is app-wide
    // and must still disable the sandbox entirely.
    const ws = makeWorkspace();
    globalSettings = { sandboxRunCommand: false, workModePreference: "build" };

    expect(sandboxFor(ws, "build")).toBeUndefined();
  });
});

/**
 * `preview.readOnly` — how a SUB-AGENT gets the observe-only profile.
 *
 * A QA sub-agent borrows the interceptor of the turn that spawned it, so on a
 * Build turn it would inherit workspace-write: the opposite of a worker whose job
 * is to observe. The preview flag narrows that per command.
 *
 * It narrows only. There is deliberately no way to request write access from a
 * preview, because a worker must never be able to widen what the turn allows.
 */
describe("preview.readOnly narrows, never widens", () => {
  it("forces read-only on a Build turn (the QA sub-agent case)", () => {
    const ws = makeWorkspace();
    globalSettings = { workModePreference: "build", selectedChatMode: "build" };

    expect(sandboxFor(ws, "build")?.readOnly).toBe(false);
    expect(sandboxFor(ws, "build", { readOnly: true })?.readOnly).toBe(true);
  });

  it("cannot widen a read-only turn", () => {
    const ws = makeWorkspace();
    globalSettings = { workModePreference: "build", selectedChatMode: "build" };

    // readOnly:false is not "please give me writes" — an Explore turn stays
    // read-only whatever the preview says.
    expect(sandboxFor(ws, "ask", { readOnly: false })?.readOnly).toBe(true);
  });

  it("a caller-forced read-only run is ENFORCED, so it fails rather than running unconfined", () => {
    const ws = makeWorkspace();
    globalSettings = { workModePreference: "build", selectedChatMode: "build" };

    expect(sandboxFor(ws, "build", { readOnly: true })?.enforce).toBe(true);
  });

  it("mode-driven read-only is NOT enforced — that would break Explore where no OS sandbox exists", () => {
    const ws = makeWorkspace();
    globalSettings = { workModePreference: "ask", selectedChatMode: "ask" };

    const sandbox = sandboxFor(ws, "ask");
    expect(sandbox?.readOnly).toBe(true);
    expect(sandbox?.enforce).toBe(false);
  });
});
