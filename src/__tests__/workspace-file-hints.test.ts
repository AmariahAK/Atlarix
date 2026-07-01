import { describe, it, expect, vi, beforeEach } from "vitest";

const getProjectFiles = vi.fn();
vi.mock("@/ipc/utils/project-files", () => ({
  getProjectFiles: (...args: unknown[]) => getProjectFiles(...args),
}));

import {
  formatSmallRepoInventory,
  isDirectoryReadPath,
  suggestClosestPath,
} from "@/lib/tools/workspace-file-hints";

describe("workspace-file-hints", () => {
  it("detects directory read paths", () => {
    expect(isDirectoryReadPath(".")).toBe(true);
    expect(isDirectoryReadPath("./")).toBe(true);
    expect(isDirectoryReadPath("")).toBe(true);
    expect(isDirectoryReadPath("src/foo.ts")).toBe(false);
  });

  it("formats small repo inventory", () => {
    const msg = formatSmallRepoInventory(["README.md", "notes.txt"]);
    expect(msg).toContain("2 tracked file");
    expect(msg).toContain("README.md");
    expect(msg).toMatch(/only 2 tracked file/);
  });
});

describe("suggestClosestPath", () => {
  const files = [
    "src/schedule/natural-language-cron.test.ts",
    "src/schedule/schedule-daemon.ts",
    "src/lib/utils.ts",
    "README.md",
  ];
  beforeEach(() => {
    getProjectFiles.mockReset();
    getProjectFiles.mockResolvedValue({ files, strategy: "test", count: files.length });
  });

  it("suggests the renamed file (edit-distance on basename)", async () => {
    // The exact observed bug: ran a stale path after renaming the file.
    const s = await suggestClosestPath(
      "/ws",
      "src/schedule/naturalLanguageCron.test.ts",
    );
    expect(s).toContain("natural-language-cron.test.ts");
    expect(s).toMatch(/did you mean/i);
  });

  it("returns null when the path exists", async () => {
    expect(await suggestClosestPath("/ws", "src/lib/utils.ts")).toBeNull();
  });

  it("returns null when nothing is close", async () => {
    expect(
      await suggestClosestPath("/ws", "src/totally/unrelated/xyzzy.ts"),
    ).toBeNull();
  });

  it("only matches within the same extension", async () => {
    // A .md typo must not match a .ts file even if basenames are close.
    expect(await suggestClosestPath("/ws", "READMEE.mdx")).toBeNull();
  });

  it("returns null on an empty workspace", async () => {
    getProjectFiles.mockResolvedValue({ files: [], strategy: "test", count: 0 });
    expect(await suggestClosestPath("/ws", "src/anything.ts")).toBeNull();
  });
});
