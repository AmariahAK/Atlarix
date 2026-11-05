/**
 * What another session sees of a pending request (0aa): built in main from the
 * request itself, so every surface publishes the same thing.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_DETAIL_CAP,
  isPeerApprovableSummary,
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
