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
  atlarixPageKernel,
  findScript,
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

  it("passes the caps as JSON arguments, not as interpolated code", () => {
    // These used to be spliced in as `const MAX = 200;`. They now travel in the
    // request object, which is the same guarantee by a safer route: a cap can
    // only ever be a number in a JSON literal, never a fragment of source.
    expect(snapshotScript("interactive")).toContain('"max":200');
    expect(snapshotScript("all")).toContain('"max":400');
    expect(findScript("x")).toContain('"max":20');
  });
});

describe("page-scripts template hygiene", () => {
  it("keeps the KERNEL free of backticks too", () => {
    // Same rule, and it now matters more: the kernel's source is spliced into
    // `browser.ts`'s template literals, so one backtick anywhere in it — a
    // comment included — silently ends the literal it lands in.
    expect(atlarixPageKernel.toString()).not.toContain("`");
  });

  it("produces a self-contained invocation for each read script", () => {
    for (const script of [snapshotScript("all"), findScript("submit button")]) {
      // `(<kernel source>)(<json request>)` — an expression that evaluates to
      // the result, which is what executeJavaScript returns.
      expect(script.startsWith("(function atlarixPageKernel(")).toBe(true);
      expect(script.trimEnd().endsWith(")")).toBe(true);
      // The ref registry must be established by the script itself, not assumed.
      expect(script).toContain("__atlarixRefs");
    }
  });

  /**
   * THE RULE THAT DID NOT EXIST BEFORE.
   *
   * While these were literal strings, a module-scope constant was interpolated
   * at build time and the page never saw the name. Now the kernel is a function
   * whose source is stringified, and a stringified function does NOT carry its
   * module — so any surviving reference is a ReferenceError in the page, on
   * whichever branch happens to touch it.
   *
   * A source-text check catches the untaken branches that a runtime test
   * cannot, which is the same reason the zero-import rule above is written this
   * way rather than as an import-graph check.
   */
  it("references nothing outside itself", () => {
    const src = atlarixPageKernel.toString();
    // Derive the module's own top-level runtime bindings rather than hard-coding
    // them, so a constant added later is covered without editing this test.
    const moduleBindings = [
      ...SOURCE.matchAll(/^export (?:const|function) (\w+)/gm),
    ]
      .map((m) => m[1])
      .filter((name) => name !== "atlarixPageKernel");
    expect(moduleBindings.length).toBeGreaterThan(0);
    for (const name of moduleBindings) {
      expect(
        new RegExp(`\\b${name}\\b`).test(src),
        `kernel source references module-scope binding "${name}"`,
      ).toBe(false);
    }
  });
});
