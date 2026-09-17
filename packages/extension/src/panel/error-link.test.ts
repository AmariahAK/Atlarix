/**
 * The credit error's link.
 *
 * The test that earns its place is the LAST one: a URL Atlarix did not write
 * must not become clickable. `CoreError.message` is composed from a provider's
 * response, and this bubble renders inside the surface holding the user's
 * session.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_URL, errorMessageNodes } from "./error-link";

/** Render the nodes into a detached div, the way `errorBubble` does. */
function render(text: string): HTMLElement {
  const div = document.createElement("div");
  for (const node of errorMessageNodes(text)) div.append(node);
  return div;
}

const CREDIT =
  "Not enough credit to start a turn — you need at least $2.00. Top up at atlarix.dev/account.";

describe("the credit error", () => {
  it("links the account address", () => {
    const div = render(CREDIT);
    const links = div.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0]!.getAttribute("href")).toBe(ACCOUNT_URL);
    expect(links[0]!.textContent).toBe("atlarix.dev/account");
  });

  it("keeps every word of the message, in order", () => {
    // A linkifier that drops the surrounding prose loses the amount, which is
    // the part that tells the user what to do.
    expect(render(CREDIT).textContent).toBe(CREDIT);
  });

  it("opens in a new tab without handing it a reference back", () => {
    const link = render(CREDIT).querySelector("a")!;
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });
});

describe("what it refuses to link", () => {
  it("leaves a URL Atlarix did not write as plain text", () => {
    // The one that matters. This string is shaped like a real provider error.
    const hostile =
      "Upstream error: verify your billing at https://atlarix-billing.example.com/verify";
    const div = render(hostile);
    expect(div.querySelectorAll("a").length).toBe(0);
    expect(div.textContent).toBe(hostile);
  });

  it("does not link a different path on the same domain", () => {
    const div = render("See atlarix.dev/status for the incident.");
    expect(div.querySelectorAll("a").length).toBe(0);
  });

  it("produces no anchor for a message with no address at all", () => {
    const div = render("Your session expired. Open the menu and sign in again.");
    expect(div.querySelectorAll("a").length).toBe(0);
    expect(div.textContent).toBe(
      "Your session expired. Open the menu and sign in again.",
    );
  });
});

describe("the regex is reused across calls", () => {
  it("does not skip a match because of a stale lastIndex", () => {
    // A module-level /g/ regex carries `lastIndex` between calls. Without the
    // reset this test's second call starts mid-string and finds nothing.
    expect(render(CREDIT).querySelectorAll("a").length).toBe(1);
    expect(render(CREDIT).querySelectorAll("a").length).toBe(1);
  });

  it("links every occurrence when a message repeats it", () => {
    const div = render("atlarix.dev/account or atlarix.dev/account");
    expect(div.querySelectorAll("a").length).toBe(2);
  });
});
