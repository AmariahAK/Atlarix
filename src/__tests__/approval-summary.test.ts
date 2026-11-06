/**
 * What another session sees of a pending request (0aa): built in main from the
 * request itself, so every surface publishes the same thing.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_DETAIL_CAP,
  isPeerApprovableSummary,
  peerMayApprove,
  summarizePermissionRequest,
} from "@/lib/peers/approval-summary";

describe("summarizePermissionRequest", () => {
  it("a command: the command line, its purpose and risk, and the danger flag", () => {
    const s = summarizePermissionRequest("op-1", {
      operation: "run_command",
      preview: {
        command: "git push --force origin main",
        workingDirectory: "/w/a",
        description: "push the release",
        isDangerous: true,
        dangerExplanation: "rewrites the remote branch",
      },
    });
    expect(s).toMatchObject({ operationId: "op-1", operation: "run_command", summary: "git push --force origin main", cwd: "/w/a", isDangerous: true });
    expect(s.detail).toContain("what: push the release");
    expect(s.detail).toContain("risk: rewrites the remote branch");
    expect(isPeerApprovableSummary(s)).toBe(false);
  });

  it("a file change: its path and diff, so the change itself can be judged", () => {
    const s = summarizePermissionRequest("op-2", {
      operation: "edit_file",
      preview: { path: "src/a.ts", type: "update", description: "fix", diff: "@@ -1 +1 @@\n-old\n+new" },
    });
    expect(s.summary).toBe("update src/a.ts");
    expect(s.detail).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(isPeerApprovableSummary(s)).toBe(true);
  });

  it("a new file: its content is the change", () => {
    const s = summarizePermissionRequest("op-3", {
      operation: "write_file",
      preview: { path: "b.ts", type: "create", description: "add", content: "export const b = 1;\n" },
    });
    expect(s.detail).toBe("export const b = 1;");
  });

  it("a long diff is cut, and says so", () => {
    const s = summarizePermissionRequest("op-4", {
      operation: "edit_file",
      preview: { path: "c.ts", type: "update", description: "big", diff: "+x\n".repeat(5_000) },
    });
    expect(s.detail!.length).toBeLessThan(APPROVAL_DETAIL_CAP + 100);
    expect(s.detail).toMatch(/\[cut: 14,999 characters in all\]$/);
  });

  it("a batch is high-risk when any of its steps is, and lists each change", () => {
    const s = summarizePermissionRequest("op-5", {
      operation: "batch_plan",
      preview: {
        operations: [
          { path: "a.ts", type: "update", description: "x", diff: "+a" },
          { command: "sudo make install", description: "install", systemScope: true },
        ],
      },
    });
    expect(s.summary).toBe("2 changes: update a.ts, sudo make install");
    expect(s.detail).toContain("+a");
    expect(s.systemScope).toBe(true);
    expect(isPeerApprovableSummary(s)).toBe(false);
  });

  it("a sandbox escalation is never peer-approvable", () => {
    const s = summarizePermissionRequest("op-6", {
      operation: "sandbox_escalation",
      preview: { deniedPath: "/x/cache", grantPath: "/x", description: "grant" },
    });
    expect(s.summary).toBe("sandbox write denied: /x/cache (grant /x)");
    expect(isPeerApprovableSummary(s)).toBe(false);
  });
});

/**
 * The request as main's permission layer HOLDS it is not the request as its card
 * SHOWED it: the stored copy of a system-scope command carries only
 * `systemScopeInteractive` (the marker that lets an approved one run outside the
 * sandbox), while `systemScope` is added by the card's enrichment. A peer's
 * answer is judged on both, so neither copy can let a high-risk request through.
 */
describe("peerMayApprove", () => {
  const stored = {
    operation: "run_command",
    // As build-branch / ask-branch buffer it: no `systemScope`, only the run marker.
    preview: { command: "sudo installer -pkg x.pkg -target /", workingDirectory: ".", isDangerous: false, systemScopeInteractive: true },
  };
  const shown = { operation: "run_command", preview: { ...stored.preview, systemScope: true, systemScopeExplanation: "installs on this Mac" } };

  it("a system-scope command as STORED (only systemScopeInteractive) is high-risk", () => {
    expect(isPeerApprovableSummary(summarizePermissionRequest("op-7", stored))).toBe(false);
    expect(peerMayApprove([stored])).toBe(false);
  });

  it("refused when EITHER the shown or the stored copy is high-risk", () => {
    expect(peerMayApprove([shown, stored])).toBe(false);
    // The card flagged it (enrichment found the danger) though the stored copy did not.
    const plainStored = { operation: "run_command", preview: { command: "rm -rf build", isDangerous: false } };
    const dangerShown = { operation: "run_command", preview: { command: "rm -rf build", isDangerous: true } };
    expect(peerMayApprove([dangerShown, plainStored])).toBe(false);
  });

  it("an ordinary request stays peer-approvable; a missing copy is skipped", () => {
    const edit = { operation: "edit_file", preview: { path: "src/a.ts", type: "update", diff: "+x" } };
    expect(peerMayApprove([undefined, edit])).toBe(true);
    // Nothing to judge: never approvable.
    expect(peerMayApprove([undefined])).toBe(false);
  });
});
