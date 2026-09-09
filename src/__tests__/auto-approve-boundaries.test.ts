import { describe, it, expect } from "vitest";
import { isAlwaysAutoApproveAtlarixRelativePath } from "@/lib/tasks/plan-sync";
import { resolveFilePermissionGate } from "@/lib/file-permission-scope";

/**
 * Two blanket-approval paths, both of which let a write land with NO approval
 * card at all (`bufferOperation` suppresses the permission-request event when
 * `shouldAlwaysAutoApprove` is true, and `auto_allow` skips the approval wait).
 * Anything they wave through, the user never sees.
 */

describe(".atlarix blanket auto-approve", () => {
  it("still auto-approves ordinary agent files", () => {
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/plans/current.md"),
    ).toBe(true);
    expect(isAlwaysAutoApproveAtlarixRelativePath(".atlarixignore")).toBe(true);
  });

  it("never auto-approves the two standing-authority files", () => {
    // Pre-existing carve-out: these are re-injected as instructions / gate tools.
    expect(isAlwaysAutoApproveAtlarixRelativePath(".atlarix/atlarix.md")).toBe(
      false,
    );
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/permissions.json"),
    ).toBe(false);
  });

  // Kept after the hooks feature was deleted in v14.26.0 — nothing executes this
  // directory now, but a guard removed because its subject went away is exactly
  // how this class of hole gets reopened. When hooks existed:
  // hooks.json was not instructions a future turn might follow — it was a command
  // string handed to `/bin/sh -c` on every pre/post tool call. A silent write to
  // it is the agent granting itself arbitrary shell.
  it("never auto-approves anything under .atlarix/hooks/", () => {
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/hooks/hooks.json"),
    ).toBe(false);
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/hooks/pre/lint.sh"),
    ).toBe(false);
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(
        "../other-repo/.atlarix/hooks/hooks.json",
      ),
    ).toBe(false);
  });

  it("a directory merely NAMED hooks elsewhere is unaffected", () => {
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/plans/hooks-notes.md"),
    ).toBe(true);
  });

  /**
   * v14.45 INVERTED the rule from allow-by-default to an allowlist, because the
   * exception-list shape had failed twice. First `.atlarix/hooks/hooks.json`, which was
   * shell-executed. Then the files below — which the carve-out missed entirely while
   * reasoning explicitly about "durable prompt-injection escalation" for the two it did
   * name, even though these outrank both.
   */
  describe("authority-bearing files require a card", () => {
    it("a mode skill — it replaced the operating instructions, ahead of the base prompt", () => {
      expect(
        isAlwaysAutoApproveAtlarixRelativePath(
          ".atlarix/skills/modes/build-mode.md",
        ),
      ).toBe(false);
    });

    it("a sub-agent prompt — it WAS a write-capable sub-agent's entire prompt", () => {
      expect(
        isAlwaysAutoApproveAtlarixRelativePath(
          ".atlarix/skills/subagents/subagent-writer.md",
        ),
      ).toBe(false);
    });

    it("a user agent — it carries mode and tools, i.e. capability", () => {
      expect(
        isAlwaysAutoApproveAtlarixRelativePath(".atlarix/agents/reviewer.md"),
      ).toBe(false);
    });

    it("a workspace skill — its name and description reach the prompt", () => {
      expect(
        isAlwaysAutoApproveAtlarixRelativePath(".atlarix/skills/release.md"),
      ).toBe(false);
    });

    it("project rules — the standing instruction layer", () => {
      // `.atlarix/rules/` replaces the single `atlarix.md`, so it inherits exactly the
      // reason `atlarix.md` was carved out in the first place.
      expect(
        isAlwaysAutoApproveAtlarixRelativePath(".atlarix/rules/testing.md"),
      ).toBe(false);
    });
  });

  /**
   * The property that makes the inversion worth doing, rather than just a longer list:
   * a convention nobody has invented yet arrives PROTECTED. If this test ever needs
   * changing, the change is adding something to the allowlist deliberately — not
   * discovering months later that it was auto-approved all along.
   */
  it("fails CLOSED for anything not explicitly allowlisted", () => {
    for (const unknown of [
      ".atlarix/whatever-comes-next/config.json",
      ".atlarix/mcp.json",
      ".atlarix/hooks.json",
      ".atlarix/some-future-authority-file",
      ".atlarix",
    ]) {
      expect(isAlwaysAutoApproveAtlarixRelativePath(unknown)).toBe(false);
    }
  });

  it("still waves through the agent's own bookkeeping", () => {
    // The whole point of the allowlist: plan writes must not interrupt the user, and
    // the plan UI already shows them.
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/plans/current.md"),
    ).toBe(true);
    expect(
      isAlwaysAutoApproveAtlarixRelativePath(".atlarix/archive/old-plan.md"),
    ).toBe(true);
  });
});

describe("file-permission gate never auto-allows outside the workspace", () => {
  const extensionAllow = [
    {
      scopeType: "extension" as const,
      scopeValue: ".ts",
      decision: "always_allow" as const,
    },
  ];

  it("an extension grant still auto-allows inside the workspace", () => {
    const gate = resolveFilePermissionGate(
      "src/app.ts",
      "edit_file",
      extensionAllow,
    );
    expect(gate.action).toBe("auto_allow");
  });

  // The dangerous case: extension scopes match on extname alone, so "always
  // allow .ts" for THIS project used to silently authorise a write to any .ts
  // file anywhere on disk the moment a folder was granted.
  it("the same grant does NOT auto-allow a .ts file outside the workspace", () => {
    const gate = resolveFilePermissionGate(
      "../other-repo/src/app.ts",
      "edit_file",
      extensionAllow,
    );
    expect(gate.action).toBe("prompt");
  });

  it("offers no always-allow options for an outside path", () => {
    const gate = resolveFilePermissionGate(
      "../other-repo/x.ts",
      "edit_file",
      extensionAllow,
    );
    if (gate.action !== "prompt") throw new Error("expected prompt");
    expect(gate.canAlwaysAllowFile).toBe(false);
    expect(gate.canAlwaysAllowDirectory).toBe(false);
    expect(gate.canAlwaysAllowExtension).toBe(false);
  });

  it("a directory grant does not leak across the boundary either", () => {
    const dirAllow = [
      {
        scopeType: "directory" as const,
        scopeValue: "src",
        decision: "always_allow" as const,
      },
    ];
    expect(
      resolveFilePermissionGate("src/a.ts", "edit_file", dirAllow).action,
    ).toBe("auto_allow");
    expect(
      resolveFilePermissionGate("../peer/src/a.ts", "edit_file", dirAllow)
        .action,
    ).toBe("prompt");
  });
});
