/**
 * Connector tools.
 *
 * THE SOURCE-LEVEL TEST IS THE POINT OF THIS FILE. The proxy wraps connector
 * output in an `<untrusted-data>` envelope, and that envelope is the only
 * remaining structural boundary between a page the agent reads and a
 * connector's tools. Two edits would quietly remove it — re-wrapping (which now
 * NESTS rather than no-ops) or, far worse, stripping — and neither would fail
 * any behavioural test. So they are forbidden at the source level, the way
 * `no-node-globals.test.ts` forbids Node globals.
 */

import { describe, expect, it } from "vitest";

/**
 * Read with `import.meta.glob`, NOT `node:fs`. This package sets `types: []`
 * precisely so a Node builtin cannot type-check, and `no-node-globals.test.ts`
 * reads its sources the same way for the same reason — a test that reaches for
 * Node is one edit away from a source file that does.
 */
const sources = import.meta.glob("./connectors.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const source = Object.values(sources)[0] ?? "";

/**
 * Comments stripped before checking.
 *
 * THE FIRST VERSION OF THIS FILE FAILED ON ITS OWN DOCBLOCK, which names both
 * forbidden functions while explaining why they are not used. `docs/TODO.md`
 * records the same trap against the backtick rule — "toString() includes
 * comments". A source-text check has to look at the code.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the envelope discipline", () => {
  it("never strips an untrusted-data envelope", () => {
    // `stripUntrustedDataEnvelope` is a DISPLAY-ONLY inverse. Running it on
    // model-facing text removes the injection defence and nothing fails.
    expect(code).not.toContain("stripUntrustedDataEnvelope");
  });

  it("never re-wraps what the proxy already wrapped", () => {
    // A CALL, not a mention — the docblock says the word on purpose.
    expect(code).not.toMatch(/wrapUntrustedData\s*\(/);
  });

  it("puts a plain header line BEFORE the envelope, never at byte 0", () => {
    // So that anything downstream which ever does wrap this actually wraps,
    // rather than meeting an open tag at position 0.
    expect(code).toMatch(/Result from connector[\s\S]{0,80}body\.result/);
    expect(code.indexOf("Result from connector")).toBeGreaterThan(-1);
  });

  it("sends the user where connectors are actually managed", () => {
    // There is no management tool here on purpose; the description has to say
    // where to go or the model discovers it by failing.
    expect(code).toContain("atlarix.dev/account");
  });
});
