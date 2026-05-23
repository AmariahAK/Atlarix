import { describe, it, expect } from "vitest";
import {
  formatSmallRepoInventory,
  isDirectoryReadPath,
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
