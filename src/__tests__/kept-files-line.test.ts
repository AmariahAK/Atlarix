import { describe, it, expect } from "vitest";
import { keptFilesLine } from "@/lib/chat/kept-files-line";

describe("keptFilesLine", () => {
  it("names what was kept, in one line", () => {
    expect(keptFilesLine(["src/a.ts", "b.ts"])).toBe("Kept a.ts, b.ts (changed since)");
  });
  it("shortens a long list", () => {
    expect(keptFilesLine(["a", "b", "c", "d", "e"])).toBe("Kept a, b, c and 2 more (changed since)");
  });
  it("says nothing when nothing was kept", () => {
    expect(keptFilesLine([])).toBeNull();
  });
});
