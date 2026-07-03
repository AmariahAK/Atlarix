import { afterEach, describe, expect, it, vi } from "vitest";

// Control the persisted decisions without a DB. Keyed by `${appId}:${category}`.
const decisions = new Map<string, "always_allow" | "always_deny">();
vi.mock("@/lib/command-permissions-store", () => ({
  getWorkspaceCommandPermission: (appId: number, category: string) =>
    decisions.get(`${appId}:${category.trim().toLowerCase()}`) ?? null,
  listWorkspaceCommandPermissions: () => [],
  upsertWorkspaceCommandPermission: () => {},
  revokeWorkspaceCommandPermission: () => false,
}));

import {
  resolveRunCommandPermissionGate,
  runCommandCategoryPreflight,
} from "@/ipc/handlers/command_permission_handlers";

const APP = 1;

afterEach(() => decisions.clear());

describe("resolveRunCommandPermissionGate (Fix 2 unified gate)", () => {
  it("non-dangerous: prompts by default, auto-allows via first-token category", () => {
    expect(resolveRunCommandPermissionGate("git status", APP)).toEqual({
      action: "prompt",
      category: "git",
      dangerous: false,
    });
    decisions.set(`${APP}:git`, "always_allow");
    expect(resolveRunCommandPermissionGate("git status", APP)).toEqual({
      action: "auto_allow",
      category: "git",
    });
  });

  it("dangerous: ALWAYS prompts when there is no explicit rule (never auto-allowed)", () => {
    const gate = resolveRunCommandPermissionGate("git push --force-with-lease", APP);
    expect(gate.action).toBe("prompt");
    expect(gate).toMatchObject({ dangerous: true, category: "danger:git-push-force-with-lease" });
  });

  it("dangerous: a COARSE first-token allow does NOT satisfy it (the safety invariant)", () => {
    // User always-allowed the whole "git" category…
    decisions.set(`${APP}:git`, "always_allow");
    // …but a dangerous git subcommand still prompts (keyed by its danger pattern).
    expect(resolveRunCommandPermissionGate("git push --force", APP).action).toBe("prompt");
  });

  it("dangerous: auto-allows ONLY with an explicit danger-key allow; deny works too", () => {
    decisions.set(`${APP}:danger:git-push-force-with-lease`, "always_allow");
    expect(
      resolveRunCommandPermissionGate("git push --force-with-lease", APP).action,
    ).toBe("auto_allow");
    // A different dangerous command is unaffected by that specific allow.
    expect(resolveRunCommandPermissionGate("git push --force", APP).action).toBe("prompt");

    decisions.set(`${APP}:danger:cmd-rm+rm-rf`, "always_deny");
    expect(resolveRunCommandPermissionGate("rm -rf build", APP).action).toBe("auto_deny");
  });

  it("no appId: prompts (with correct danger classification), never auto-allows", () => {
    expect(resolveRunCommandPermissionGate("git status", null).action).toBe("prompt");
    expect(resolveRunCommandPermissionGate("rm -rf /", null)).toMatchObject({
      action: "prompt",
      dangerous: true,
    });
  });

  it("runCommandCategoryPreflight mirrors the gate: dangerous-without-rule is a prompt (skip=false)", () => {
    const pf = runCommandCategoryPreflight("git push --force", APP);
    expect(pf.type).toBe("prompt");
    expect(pf).toMatchObject({ dangerous: true });
  });
});
