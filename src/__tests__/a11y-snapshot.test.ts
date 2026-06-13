import { describe, expect, it } from "vitest";
import {
  formatA11ySnapshot,
  type A11ySnapshot,
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
    // The header tells the model how to act on refs.
    expect(out).toContain("browser_click/browser_fill");
  });

  it("flags truncation and shows current values", () => {
    const snap: A11ySnapshot = {
      url: "u",
      title: "t",
      count: 1,
      truncated: true,
      elements: [{ ref: "e1", role: "input", name: "Search", value: "abc" }],
    };
    const out = formatA11ySnapshot(snap);
    expect(out).toContain("capped at");
    expect(out).toContain('value="abc"');
  });
});
