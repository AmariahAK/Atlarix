import { describe, it, expect } from "vitest";
import { mergeElision, isElisionMarker } from "@/lib/tools/edit-merge";

const ORIGINAL = [
  "function a() {",
  "  const x = 1;",
  "  const y = 2;",
  "  const z = 3;",
  "  const w = 4;",
  "  return x + y;",
  "}",
].join("\n");

describe("isElisionMarker", () => {
  it.each([
    "// ... existing code ...",
    "  # ... existing code ...",
    "/* ... existing ... */",
    "    ...",
    "// ... unchanged ...",
    "<!-- ... existing code ... -->",
  ])("recognizes %s", (l) => {
    expect(isElisionMarker(l)).toBe(true);
  });

  it.each([
    "const x = { ...props };",
    "  return spread(...args);",
    "function a() {",
    "const y = 2;",
  ])("does NOT flag ordinary code: %s", (l) => {
    expect(isElisionMarker(l)).toBe(false);
  });
});

describe("mergeElision", () => {
  it("keeps the elided span from the original while applying the change", () => {
    const sketch = [
      "function a() {",
      "  const x = 1;",
      "  const y = 20;", // changed
      "  const z = 3;", // unchanged anchor before marker
      "// ... existing code ...", // elides `const w = 4;`
      "  return x + y;", // unchanged anchor after marker
      "}",
    ].join("\n");
    const res = mergeElision(ORIGINAL, sketch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.merged).toContain("const y = 20;"); // change applied
    expect(res.merged).toContain("const w = 4;"); // elided span preserved
    expect(res.fullRewrite).toBe(false);
  });

  it("keeps the original HEAD on a leading marker", () => {
    // marker elides the head; the line right after it is unchanged (anchor),
    // then a changed line.
    const sketch = [
      "// ... existing code ...",
      "  const w = 4;", // unchanged anchor after the leading marker
      "  return x + y + 99;", // changed
      "}",
    ].join("\n");
    const res = mergeElision(ORIGINAL, sketch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.merged).toContain("function a() {"); // head kept
    expect(res.merged).toContain("const x = 1;"); // head kept
    expect(res.merged).toContain("return x + y + 99;"); // change applied
  });

  it("keeps the original TAIL on a trailing marker", () => {
    const sketch = [
      "function a() {",
      "  const x = 10;", // changed
      "  const y = 2;", // unchanged anchor before the trailing marker
      "// ... existing code ...",
    ].join("\n");
    const res = mergeElision(ORIGINAL, sketch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.merged).toContain("const x = 10;"); // change applied
    expect(res.merged).toContain("const w = 4;"); // tail kept
    expect(res.merged).toContain("return x + y;"); // tail kept
  });

  it("treats a sketch with no markers as a full rewrite", () => {
    const res = mergeElision(ORIGINAL, "const q = 1;\n");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fullRewrite).toBe(true);
    expect(res.merged).toBe("const q = 1;\n");
  });

  it("REFUSES (no corruption) when a marker's adjacent line can't be anchored", () => {
    const sketch = [
      "function a() {",
      "  const totallyNew = 999;", // not in original — bad anchor before marker
      "// ... existing code ...",
      "  return x + y;",
      "}",
    ].join("\n");
    const res = mergeElision(ORIGINAL, sketch);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/anchor/i);
  });
});
