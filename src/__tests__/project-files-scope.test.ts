import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "child_process";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("@/lib/index/ctags-index", () => ({
  ensureSymbolIndex: vi.fn(),
  getSymbolsForFile: vi.fn(),
}));

describe("getProjectFiles scoped git", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("lists only files under scopePath via git pathspec", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-scope-"));
    execSync("git init", { cwd: tmp, stdio: "ignore" });
    fs.mkdirSync(path.join(tmp, "pkg-a", "src"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "pkg-b"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "pkg-a", "src", "a.ts"), "export {}");
    fs.writeFileSync(path.join(tmp, "pkg-b", "b.ts"), "export {}");
    execSync("git add -A", { cwd: tmp, stdio: "ignore" });

    const { getProjectFiles, clearFileListCache } = await import(
      "@/ipc/utils/project-files"
    );
    clearFileListCache(tmp);

    const result = await getProjectFiles(tmp, { scopePath: "pkg-a" });
    expect(result.strategy).toBe("git");
    expect(result.files).toContain("src/a.ts");
    expect(result.files.some((f) => f.includes("pkg-b"))).toBe(false);
  });
});
