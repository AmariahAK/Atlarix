import { describe, expect, it } from "vitest";
import { approvalConfirmation, nativeDir, outsideWorkspace } from "@/cli/agent/approval-choices";
import type { PendingApproval } from "@/cli/agent/session";

const card = (preview: Record<string, unknown>, operation = "run_command"): PendingApproval => ({
  operationId: "op_1",
  request: { operation, preview },
});

describe("approval paths as each system writes them (QA, Windows VM)", () => {
  it("a Windows folder keeps its backslashes", () => {
    expect(nativeDir("C:/Users/Public")).toBe("C:\\Users\\Public\\");
    expect(nativeDir("src/lib", "darwin")).toBe("src/lib/");
  });

  it("a relative folder takes the running system's separator (QA, Windows ACP)", () => {
    expect(nativeDir("src", "win32")).toBe("src\\");
    expect(nativeDir("src/lib", "win32")).toBe("src\\lib\\");
    expect(nativeDir("src", "linux")).toBe("src/");
  });

  it("knows a file outside the project, on Windows and elsewhere", () => {
    const ws = "C:\\Users\\Amariah Abishai\\atlarix-qa\\ws one";
    expect(outsideWorkspace("C:\\Users\\Public\\atlarix qa test.txt", ws)).toBe(true);
    expect(outsideWorkspace("c:/users/amariah abishai/atlarix-qa/ws one/src/math.ts", ws)).toBe(false);
    expect(outsideWorkspace("src/math.ts", ws)).toBe(false);
    expect(outsideWorkspace("/tmp/x.txt", "/Users/me/app")).toBe(true);
    expect(outsideWorkspace("/Users/me/app-old/x.ts", "/Users/me/app")).toBe(true);
    expect(outsideWorkspace("/Users/me/app/x.ts", "/Users/me/app")).toBe(false);
  });
});

describe("the line an answered approval leaves (shared with the editors)", () => {
  it("a command: this time, or the rule that was saved", () => {
    expect(approvalConfirmation(card({ command: "git status" }), "once")).toBe(
      "✓ You approved Atlarix to run `git status` this time",
    );
    expect(approvalConfirmation(card({ command: "npm run build", commandCategory: "npm" }), "always_allow")).toBe(
      "✓ You approved Atlarix to always run commands that start with `npm` in this folder",
    );
    // A risky command's rule is that exact command, so the line names it.
    expect(
      approvalConfirmation(card({ command: "rm -rf build", commandCategory: "danger:rm-rf", isDangerous: true }), "always_allow"),
    ).toBe("✓ You approved Atlarix to always run `rm -rf build` in this folder");
    expect(approvalConfirmation(card({ command: "git commit -m x", commandCategory: "mutate:git-write" }), "always_allow")).toBe(
      "✓ You approved Atlarix to always make changes like `git commit -m x` in this folder",
    );
  });

  it("a long or multi-line command is one line in the receipt", () => {
    const line = approvalConfirmation(card({ command: `echo a &&\n  ${"x".repeat(300)}` }), "once")!;
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(180);
  });

  it("a file: this time, this file from now on, or its folder", () => {
    expect(approvalConfirmation(card({ path: "src/app.ts" }, "edit_file"), "once")).toBe(
      "✓ You approved Atlarix to edit `src/app.ts` this time",
    );
    expect(approvalConfirmation(card({ path: "src/new.ts", type: "create" }, "write_file"), "once")).toBe(
      "✓ You approved Atlarix to create `src/new.ts` this time",
    );
    expect(approvalConfirmation(card({ path: "old.ts", type: "delete" }, "delete_file"), "once")).toBe(
      "✓ You approved Atlarix to delete `old.ts` this time",
    );
    expect(approvalConfirmation(card({ path: "src/app.ts" }, "edit_file"), "always_allow_file")).toBe(
      "✓ You approved Atlarix to edit `src/app.ts` from now on",
    );
    expect(approvalConfirmation(card({ path: "src/app.ts", fileParentDir: "src" }, "edit_file"), "always_allow_directory")).toBe(
      "✓ You approved Atlarix to edit files in `src/` and everything under it from now on",
    );
    expect(approvalConfirmation(card({ deniedPath: "/etc/hosts" }, "write_file"), "once")).toBe(
      "✓ You approved Atlarix to write to `/etc/hosts` this time",
    );
  });

  it("nothing to confirm: a no, or a request with no command or file", () => {
    expect(approvalConfirmation(card({ command: "git status" }), "deny")).toBeNull();
    expect(approvalConfirmation(card({ action: "create" }, "automation_write"), "once")).toBeNull();
  });
});

describe("the folder in the confirmation line, on Windows (release CI)", () => {
  const onWindows = <T>(fn: () => T): T => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  };

  it("a project folder reads with \"/\", as the rule is stored; a drive path keeps its own", () => {
    expect(
      onWindows(() => approvalConfirmation(card({ path: "src/app.ts", fileParentDir: "src" }, "edit_file"), "always_allow_directory")),
    ).toBe("✓ You approved Atlarix to edit files in `src/` and everything under it from now on");
    expect(
      onWindows(() =>
        approvalConfirmation(card({ path: "C:/Users/Public/a.txt", fileParentDir: "C:/Users/Public" }, "edit_file"), "always_allow_directory"),
      ),
    ).toBe(
      "✓ You approved Atlarix to edit files in `C:\\Users\\Public\\` and everything under it from now on",
    );
  });
});
