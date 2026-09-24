/**
 * `page-scripts/visual.ts` runs in the user's Chrome via
 * `chrome.scripting.executeScript({ func })`, which serializes each function
 * with `toString()` — so it must obey the same rules as the kernel: no runtime
 * imports, no reference to module scope, no backticks.
 *
 * The functions are also RUN here under jsdom, the closest thing to executing
 * the serialized source: a reference to module scope would still pass a
 * direct call, so each is round-tripped through `new Function(toString())`
 * first — exactly what Chrome does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  atlarixDesignSnapshot,
  atlarixVisualLint,
} from "@/lib/browser/page-scripts/visual";
import { VISUAL_LINT_ARGS } from "@/lib/browser/visual-report";

const SOURCE = readFileSync(
  join(__dirname, "..", "..", "lib", "browser", "page-scripts", "visual.ts"),
  "utf8",
);

/** What Chrome does with `func`: stringify, then rebuild in a fresh scope. */
function reserialize<T extends (...a: never[]) => unknown>(fn: T): T {
  return new Function(`return (${fn.toString()})`)() as T;
}

describe("visual page functions: portability", () => {
  it("has no runtime imports", () => {
    const runtimeImports = SOURCE.split("\n").filter((line) =>
      /^\s*import\s+(?!type\b)/.test(line),
    );
    expect(runtimeImports).toEqual([]);
  });

  it("contains no backtick inside either serialized function", () => {
    expect(atlarixVisualLint.toString()).not.toContain("`");
    expect(atlarixDesignSnapshot.toString()).not.toContain("`");
  });
});

describe("visual page functions: they run after serialization", () => {
  it("atlarixVisualLint reports a blank page and measures CLS without throwing", async () => {
    document.body.innerHTML = "";
    const run = reserialize(atlarixVisualLint);
    const raw = await run(VISUAL_LINT_ARGS);
    expect(raw.defects.map((d) => d.rule)).toContain("blank-render");
    expect(raw.axeAvailable).toBe(false);
  });

  it("atlarixDesignSnapshot runs after serialization", () => {
    document.body.innerHTML = "<main><p>Hello</p></main>";
    const snap = reserialize(atlarixDesignSnapshot)();
    expect(Array.isArray(snap.palette)).toBe(true);
    expect(snap.layout.some((l) => l.startsWith("main:"))).toBe(true);
  });
});
