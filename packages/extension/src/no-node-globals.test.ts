/**
 * Nothing in this package may reach for Node.
 *
 * WHY A SOURCE-TEXT TEST, WHEN THERE ARE TWO OTHER GUARDS. Because each has a
 * hole:
 *
 *   - `tsconfig.json`'s `types: []` catches `import fs from "node:fs"` — and it
 *     is the strongest of the three — but only when `npm run ts:extension`
 *     actually runs, which is a separate command from the test suite most
 *     people run while working.
 *   - The `extension` vitest project cannot help AT ALL, and this is the part
 *     worth knowing: jsdom-under-vitest does not remove Node's globals. It
 *     filters out anything already present on the Node global unless the key is
 *     on its own list, and `process` and `Buffer` are on neither — so they
 *     resolve here and fail in Chrome. A passing suite is not evidence that the
 *     code can run in a browser.
 *   - `scripts/build-extension.mjs`'s resolve plugin catches a Node BUILTIN,
 *     but not a bare `process.env` reference, which resolves to nothing at
 *     build time and throws at runtime.
 *
 * So this is the cheap check that runs whenever anyone runs the tests, in the
 * same source-text style as `src/__tests__/page-scripts-portable.test.ts` and
 * for the same stated reason: a type-level check passes on an `import type`
 * while missing the `import log from "electron-log"` someone adds for one debug
 * line.
 *
 * It reads the sources with `import.meta.glob` rather than `node:fs`, because a
 * guard that breaks its own rule is not one. See `types/vite-glob.d.ts`.
 */

import { describe, expect, it } from "vitest";

/** Every `.ts` under src, as raw text, keyed by path relative to this file. */
const MODULES = import.meta.glob("./**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Shipped source only — a test may use Node, a `.d.ts` ships nothing. */
const FILES = Object.entries(MODULES).filter(
  ([path]) => !path.endsWith(".test.ts") && !path.endsWith(".d.ts"),
);

/** Strip comments, so prose about Node does not trip the check on itself. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Also strip string literals, for the checks where a MENTION is legitimate.
 *
 * `auth/redirect.ts` builds an error message containing the text
 * "chrome.identity.getRedirectURL()", which is exactly the advice the reader
 * needs and is not a call. Kept separate from `codeOf` because the Node checks
 * must NOT strip strings — `from "node:fs"` lives inside one.
 */
function codeWithoutStrings(source: string): string {
  return codeOf(source)
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

function offenders(
  pattern: RegExp,
  transform: (s: string) => string = codeOf,
): string[] {
  return FILES.filter(([, source]) => pattern.test(transform(source))).map(
    ([path]) => path,
  );
}

describe("the extension package stays browser-only", () => {
  it("finds source files to check at all", () => {
    // A guard that silently scans nothing is worse than no guard: it reports
    // green forever and nobody notices the glob stopped matching.
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES.map(([p]) => p)).toContain("./auth/sign-in.ts");
  });

  it.each([
    ["a node: builtin", /from\s+["']node:/],
    ["a bare require", /\brequire\s*\(/],
    ["process", /\bprocess\s*\./],
    ["Buffer", /\bBuffer\b/],
    ["__dirname", /\b__dirname\b/],
    ["electron", /from\s+["']electron/],
  ])("uses no %s", (_label, pattern) => {
    expect(offenders(pattern)).toEqual([]);
  });

  it("reaches the extension API through shared/browser-api, not the global", () => {
    // `api()` is what keeps a Firefox port an adapter rather than a fork, and
    // it is where the capability probe lives. A direct `chrome.` reference
    // bypasses both.
    const found = offenders(/(?<![\w.])chrome\s*\./, codeWithoutStrings).filter(
      (path) => path !== "./shared/browser-api.ts",
    );
    expect(found).toEqual([]);
  });

  it("keeps import.meta.glob out of shipped source — esbuild cannot bundle it", () => {
    // It is a VITE transform. A source file using it type-checks, passes this
    // suite (vitest runs through Vite), and then ships a literal
    // `import.meta.glob(...)` that throws in the browser.
    expect(offenders(/import\.meta\.glob/)).toEqual([]);
  });
});
