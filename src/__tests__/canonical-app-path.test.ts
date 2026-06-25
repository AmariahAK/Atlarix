import { describe, expect, it } from "vitest";
import {
  normalizeAppPath,
  groupDuplicateAppIds,
} from "@/lib/canonical-app-path";

describe("normalizeAppPath (Bug 5)", () => {
  it("strips trailing slashes (same folder, different representation)", () => {
    const a = normalizeAppPath("/Users/x/proj");
    expect(normalizeAppPath("/Users/x/proj/")).toBe(a);
    expect(normalizeAppPath("/Users/x/proj///")).toBe(a);
  });

  it("collapses .. and . segments", () => {
    expect(normalizeAppPath("/Users/x/proj/../proj")).toBe(
      normalizeAppPath("/Users/x/proj"),
    );
  });

  it("returns empty for blank input", () => {
    expect(normalizeAppPath("")).toBe("");
    expect(normalizeAppPath("   ")).toBe("");
    expect(normalizeAppPath(null)).toBe("");
    expect(normalizeAppPath(undefined)).toBe("");
  });

  it("case-folds only on case-insensitive filesystems", () => {
    const folded =
      normalizeAppPath("/Users/X/Proj") === normalizeAppPath("/users/x/proj");
    expect(folded).toBe(
      process.platform === "darwin" || process.platform === "win32",
    );
  });
});

describe("groupDuplicateAppIds (Bug 5)", () => {
  it("groups rows sharing a normalized path with the oldest id first (canonical)", () => {
    const groups = groupDuplicateAppIds([
      { id: 3, path: "/Users/x/proj/" },
      { id: 1, path: "/Users/x/proj" },
      { id: 2, path: "/Users/x/other" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([1, 3]); // oldest (1) is canonical
  });

  it("returns no groups when every path is distinct", () => {
    expect(
      groupDuplicateAppIds([
        { id: 1, path: "/a" },
        { id: 2, path: "/b" },
      ]),
    ).toEqual([]);
  });

  it("ignores blank paths", () => {
    expect(
      groupDuplicateAppIds([
        { id: 1, path: "" },
        { id: 2, path: "" },
      ]),
    ).toEqual([]);
  });
});
