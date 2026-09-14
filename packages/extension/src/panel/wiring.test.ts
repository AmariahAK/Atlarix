/**
 * The panel's markup and its script must agree about every id.
 *
 * WHY THIS IS WORTH A TEST. Every lookup in `sidepanel.ts` is
 * `document.querySelector(...)` into an optional, and every use is behind `?.`
 * — which is correct (a panel that throws on load renders nothing at all) and
 * which means a renamed or deleted id produces NO error anywhere. The Send
 * button simply stops working. There is no console message, no red, and no
 * failing test unless it is this one.
 *
 * It reads both files as TEXT rather than mounting the page, because mounting
 * would prove the ids match the ids — the question is whether the ids match the
 * MARKUP that ships, and the markup is a separate file the build copies
 * verbatim.
 *
 * `import.meta.glob` rather than `node:fs`, for the reason `no-node-globals.ts`
 * gives at length: a guard that breaks the package's own rule is not one.
 */

import { describe, expect, it } from "vitest";

const SCRIPT = import.meta.glob("./sidepanel.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})["./sidepanel.ts"];

const MARKUP = import.meta.glob("./sidepanel.html", {
  query: "?raw",
  import: "default",
  eager: true,
})["./sidepanel.html"];

/** Ids the script asks the document for. */
function requestedIds(source: string): string[] {
  const ids = new Set<string>();
  for (const m of source.matchAll(/\bel<[^>]*>\(\s*"([\w-]+)"\s*\)/g)) {
    ids.add(m[1]);
  }
  for (const m of source.matchAll(/querySelector\w*\(\s*"#([\w-]+)"/g)) {
    ids.add(m[1]);
  }
  return [...ids].sort();
}

/** The markup minus its comments — which talk ABOUT inline script and style. */
const MARKUP_CODE = MARKUP.replace(/<!--[\s\S]*?-->/g, "");

function markupIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
}

describe("every element the script looks up exists in the markup", () => {
  it("finds all of them", () => {
    const wanted = requestedIds(SCRIPT);
    // A guard that matched nothing would pass forever.
    expect(wanted.length).toBeGreaterThan(10);
    const have = markupIds(MARKUP);
    expect(wanted.filter((id) => !have.has(id))).toEqual([]);
  });
});

describe("the markup carries no inline script or style", () => {
  it("has neither, because MV3's default CSP silently refuses both", () => {
    // The manifest deliberately declares no `content_security_policy`, so an
    // inline handler fails at load with a console violation and an unrendered
    // UI — which reads as a broken panel rather than as a policy decision.
    expect(MARKUP_CODE).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(MARKUP_CODE).not.toMatch(/<style\b/i);
    expect(MARKUP_CODE).not.toMatch(/\son\w+=/i);
  });

  it("loads its script as a module from a file, not from a data URL", () => {
    expect(MARKUP_CODE).toContain('<script type="module" src="sidepanel.js">');
  });
});

describe("the script never builds DOM from a string", () => {
  it("uses no innerHTML, outerHTML or insertAdjacentHTML", () => {
    // What this renders is model output, which in this product is downstream of
    // web pages the agent read. `markdown.ts` carries the full argument; this
    // is the rule applied to the panel itself.
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(
      /(^|[^:])\/\/.*$/gm,
      "$1",
    );
    expect(code).not.toMatch(/\.innerHTML\b/);
    expect(code).not.toMatch(/\.outerHTML\b/);
    expect(code).not.toMatch(/insertAdjacentHTML/);
    expect(code).not.toMatch(/document\.write/);
  });
});

