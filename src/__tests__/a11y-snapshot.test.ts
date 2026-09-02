import { describe, expect, it } from "vitest";
import {
  formatA11ySnapshot,
  formatA11yFind,
  type A11ySnapshot,
  type A11yFindResult,
} from "@/lib/browser/a11y-snapshot";

describe("formatA11ySnapshot", () => {
  it("renders one compact line per element with ref + role + name", () => {
    const snap: A11ySnapshot = {
      url: "https://app.test/login",
      title: "Login",
      count: 3,
      truncated: false,
      elements: [
        { ref: "e1", role: "link", name: "Home" },
        { ref: "e2", role: "input", name: "", placeholder: "Email" },
        { ref: "e3", role: "button", name: "Sign in" },
      ],
    };
    const out = formatA11ySnapshot(snap);
    expect(out).toContain("3 interactive element(s)");
    expect(out).toContain('[e1] link "Home"');
    expect(out).toContain('[e2] input placeholder="Email"');
    expect(out).toContain('[e3] button "Sign in"');
    // The header tells the model how to act on refs. v14.41: the act surface is
    // the consolidated `browser` tool, so naming `browser_interact` here would
    // point at a name that only resolves as an alias.
    expect(out).toContain("Act on any ref with browser");
  });

  it("reports the REAL total when truncated, not just the cap", () => {
    // "capped at 200" told the model the cap, not how much it was missing — so
    // a truncated read looked complete. It must say what it didn't show.
    const snap: A11ySnapshot = {
      url: "u",
      title: "t",
      count: 200,
      total: 1340,
      truncated: true,
      elements: [{ ref: "e1", role: "input", name: "Search", value: "abc" }],
    };
    const out = formatA11ySnapshot(snap);
    expect(out).toContain("showing 200 of 1340");
    expect(out).toContain('value="abc"');
  });

  it("renders the combined read (content + controls) for filter:\"all\"", () => {
    const snap: A11ySnapshot = {
      url: "https://app.test/",
      title: "Docs",
      count: 3,
      total: 3,
      truncated: false,
      filter: "all",
      viewport: "1280x800",
      elements: [
        { ref: "e1", role: "h1", name: "", text: "Getting started", kind: "content" },
        { ref: "e2", role: "p", name: "", text: "Install the CLI first.", kind: "content" },
        { ref: "e3", role: "button", name: "Copy", kind: "control" },
      ],
    };
    const out = formatA11ySnapshot(snap);
    // Content and controls come back together — no second call needed to act.
    expect(out).toContain("page content + interactive controls");
    expect(out).toContain("[e1] h1 — Getting started");
    expect(out).toContain("[e2] p — Install the CLI first.");
    expect(out).toContain('[e3] button "Copy"');
  });

  it("discloses the viewport it was measured at", () => {
    // The browser panel is resizable, so geometry-bearing reads are meaningless
    // without the width — a page read at 399px is the mobile layout.
    const snap: A11ySnapshot = {
      url: "u",
      title: "t",
      count: 0,
      truncated: false,
      viewport: "1280x800",
      elements: [],
    };
    expect(formatA11ySnapshot(snap)).toContain("Rendered at 1280x800");
  });
});

describe("formatA11yFind", () => {
  const base = { url: "u", title: "t", query: "sign in" };

  it("lists matches best-first with actionable refs", () => {
    const res: A11yFindResult = {
      ...base,
      total: 2,
      truncated: false,
      matches: [
        { ref: "e3", role: "button", name: "Sign in", score: 90 },
        { ref: "e9", role: "a", name: "Sign in with Google", score: 40 },
      ],
    };
    const out = formatA11yFind(res);
    expect(out).toContain('[e3] button "Sign in"');
    expect(out).toContain("Act on a ref with browser");
    expect(out).not.toContain("narrow the query");
  });

  it("says so when matches were capped, instead of truncating silently", () => {
    const res: A11yFindResult = {
      ...base,
      query: "link",
      total: 57,
      truncated: true,
      matches: [{ ref: "e1", role: "a", name: "Home", score: 20 }],
    };
    expect(formatA11yFind(res)).toContain("More matches exist (57 total)");
  });

  it("tells the model what to do next when nothing matched", () => {
    const res: A11yFindResult = { ...base, total: 0, truncated: false, matches: [] };
    const out = formatA11yFind(res);
    expect(out).toContain('No elements matched "sign in"');
    expect(out).toContain("browser_inspect");
  });
});
