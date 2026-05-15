import { describe, expect, it } from "vitest";
import { isExcludedDir } from "../ipc/utils/file_utils";

describe("isExcludedDir", () => {
  it("excludes CDK deploy/staging dirs aligned with project-files ALWAYS_EXCLUDE", () => {
    expect(isExcludedDir(".cdk-out-deploy")).toBe(true);
    expect(isExcludedDir(".cdk-staging")).toBe(true);
  });

  it("excludes 64-char hex directory names (CDK asset hashes)", () => {
    expect(
      isExcludedDir("0".repeat(64)),
    ).toBe(true);
    expect(
      isExcludedDir("a".repeat(63)),
    ).toBe(false);
  });

  it("excludes directories named asset.*", () => {
    expect(isExcludedDir("asset.abc123")).toBe(true);
    expect(isExcludedDir("assets")).toBe(false);
  });
});
