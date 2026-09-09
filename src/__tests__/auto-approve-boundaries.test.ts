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
