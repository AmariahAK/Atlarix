/**
 * `lib/browser/page-scripts` must stay runnable in a Chrome content script.
 *
 * WHY THIS TEST EXISTS. The extension and the in-app browser show the model ONE
 * tool contract (`browser` / `browser_inspect` with a `target`), and that promise
 * only holds because both backends execute the SAME page-realm strings. A content
 * script cannot resolve `electron`, `node:*`, or anything that reaches for them
 * transitively — so the moment this module grows an import, the extension breaks
 * at runtime in a way no desktop test would notice.
 *
 * It is a source-text test on purpose: a type-level or import-graph check would
 * pass on a `import type`, which is fine, while missing the `import log from
 * "electron-log"` that someone adds for one debug line.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESOLVE_FILLABLE_JS,
  findScript,
  resolveElementJs,
  snapshotScript,
} from "@/lib/browser/page-scripts";

const SOURCE = readFileSync(
  join(__dirname, "..", "lib", "browser", "page-scripts", "index.ts"),
  "utf8",
);

describe("page-scripts portability", () => {
  it("has no runtime imports at all", () => {
    const runtimeImports = SOURCE.split("\n").filter((line) =>
      /^\s*import\s+(?!type\b)/.test(line),
    );
    expect(runtimeImports).toEqual([]);
  });

  it("has no require() or dynamic import", () => {
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
  });

  it("never uses a Node-only global in code", () => {
    // Comments legitimately mention Electron and Node; code must not touch them.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /^\s*\/\/.*$/gm,
      "",
    );
    for (const forbidden of [
      /\bprocess\s*\./,
      /\b__dirname\b/,
      /\bBuffer\b/,
      /\brequire\b/,
      /from\s+["']electron/,
      /from\s+["']node:/,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});

describe("page-scripts injection safety", () => {
  // Model input reaches a script ONLY through JSON.stringify. These are the
  // strings that would break out if anyone switched to interpolation.
  const HOSTILE = `"); alert(1); //`;

  it("embeds a find query without breaking out of its literal", () => {
    const script = findScript(HOSTILE);
    expect(script).toContain(JSON.stringify(HOSTILE));
    expect(script).not.toContain("alert(1); //`");
  });

  it("embeds a ref and a selector without breaking out", () => {
    const script = resolveElementJs(HOSTILE, HOSTILE);
    expect(script).toContain(JSON.stringify(HOSTILE));
    // The ref additionally goes through CSS.escape at runtime.
    expect(script).toContain("CSS.escape(__ref)");
  });

  it("keeps caps as literals, not interpolated input", () => {
    expect(snapshotScript("interactive")).toContain("const MAX = 200;");
    expect(snapshotScript("all")).toContain("const MAX = 400;");
  });
});

describe("page-scripts template hygiene", () => {
  it("keeps RESOLVE_FILLABLE_JS free of backticks", () => {
    // A backtick — even inside a comment — silently ends the template literal
    // it is embedded in. This has broken the build twice.
    expect(RESOLVE_FILLABLE_JS).not.toContain("`");
  });

  it("produces a self-contained IIFE for each read script", () => {
    for (const script of [snapshotScript("all"), findScript("submit button")]) {
      expect(script.startsWith("(() => {")).toBe(true);
      expect(script.trimEnd().endsWith("})()")).toBe(true);
      // The ref registry must be established by the script itself, not assumed.
      expect(script).toContain("window.__atlarixRefs");
    }
  });
});
