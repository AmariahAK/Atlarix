/**
 * The Chrome seam — the refusals, which ARE the feature. Since v14.52.0 the
 * user's Chrome is the agent's only browser, so no refusal may send the model
 * to a `target:"app"` that no longer exists.
 *
 * WHY THE ASSERTIONS ARE ON MESSAGE TEXT AND NOT ON `success === false`.
 * Every state below already failed before this change; it just failed the same
 * anonymous way each time, and the model's only recovery was to guess. The
 * deliverable is that each failure names its own cause and the next move, so a
 * test that only checked the boolean would pass against exactly the behaviour
 * this replaced.
 *
 * THE ABSENT CASE IS ALSO PINNED. There is no "not signed in" refusal, and
 * `no refusal mentions signing in` is a real assertion rather than an omission:
 * `requireAuthSession()` gates every turn before any tool runs, so a login
 * message here would send a user hunting for a sign-in that is not the problem.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const connected = { value: true };
const requestMock = vi.fn();
const serverPresent = { value: true };

vi.mock("@/main/bridge-lifecycle", () => ({
  bridge: () =>
    serverPresent.value
      ? {
          get connected() {
            return connected.value;
          },
          request: requestMock,
        }
      : null,
}));

import {
  chromeActionOp,
  chromeInspectOp,
  chromeTabsOp,
  chromeUnavailable,
  isChromeRefusal,
  noteIfThin,
  requestChrome,
} from "@/lib/tools/browser-target";
import { CHROME_STORE_URL } from "@/lib/bridge/host-install";
import { isToolAllowedInMode } from "@/lib/tools/mode-tool-registry";

beforeEach(() => {
  serverPresent.value = true;
  connected.value = true;
  requestMock.mockReset();
});

describe("availability refusals", () => {
  it("names the missing relay, not the browser, when this build has no bridge", () => {
    serverPresent.value = false;
    const r = chromeUnavailable();
    expect(r?.error).toContain("no browser bridge");
    expect(r?.error).not.toContain('target:"app"');
    // Must NOT tell the user to install an extension — the extension is not
    // the missing piece, and sending them to the store would waste their time.
    expect(r?.error).not.toContain(CHROME_STORE_URL);
  });

  it("carries the store link when no browser is connected", () => {
    connected.value = false;
    const r = chromeUnavailable();
    expect(r?.error).toContain(CHROME_STORE_URL);
    expect(r?.error).toContain("Settings → Browser");
    expect(r?.error).not.toContain('target:"app"');
    // All three indistinguishable causes are offered, cheapest first.
    expect(r?.error).toMatch(/running\?/);
  });

  it("is silent when a browser is connected", () => {
    expect(chromeUnavailable()).toBeNull();
  });
});

describe("mode and action refusals name the gap", () => {
  it("an unknown mode names the real ones instead of an alternative browser", () => {
    const r = chromeInspectOp("xray");
    expect(isChromeRefusal(r)).toBe(true);
    if (!isChromeRefusal(r)) return;
    expect(r.error).toContain('"visual"');
    expect(r.error).not.toContain('target:"app"');
  });

  // console/network joined this list on 2026-09-17. They used to refuse with a
  // reason claiming the extension COULD not capture them; it could, and the
  // `debugger` permission it needed was already granted and justified.
  // screenshot joined on 2026-09-23 (CDP on the agent's own tabs).
  // visual/design joined on v14.52.0, ported into portable page functions.
  it.each([
    "read",
    "snapshot",
    "text",
    "visual",
    "design",
    "console",
    "network",
    "screenshot",
  ])(
    "mode:%s maps to a bridged op",
    (mode) => {
      expect(typeof chromeInspectOp(mode)).toBe("string");
    },
  );

  // key/hover are NOT in this list any more. They were refused as "the
  // extension has no key-press op", which was simply untrue: the extension has
  // had real keystrokes over `chrome.debugger` since it shipped, and only the
  // bridge lacked the case. A refusal that misstates a capability is worse than
  // no refusal, because it stops anyone looking for the one-line fix.
  it.each(["find", "click", "fill", "scroll", "navigate", "key", "hover"])(
    "action:%s maps to a bridged op",
    (action) => {
      expect(typeof chromeActionOp(action)).toBe("string");
    },
  );

  it('tabs operation:"switch" refuses rather than silently doing nothing', () => {
    const r = chromeTabsOp("switch");
    expect(isChromeRefusal(r)).toBe(true);
    if (!isChromeRefusal(r)) return;
    expect(r.error).toContain("focus");
  });

  it.each([
    ["list", "list_tabs"],
    ["create", "open_tab"],
    ["close", "close_tab"],
  ])("tabs operation:%s maps to %s", (op, expected) => {
    expect(chromeTabsOp(op)).toBe(expected);
  });
});

describe("the extension's own errors reach the model verbatim", () => {
  it("passes the site-grant refusal through unchanged", async () => {
    const grant =
      "Atlarix has not been allowed to work on https://example.com. Open the " +
      "Atlarix side panel in the browser and allow that site — granting needs " +
      "a click in the browser and cannot be done from the desktop app.";
    requestMock.mockRejectedValueOnce(new Error(grant));
    const r = await requestChrome("read_page", {});
    expect(isChromeRefusal(r)).toBe(true);
    if (!isChromeRefusal(r)) return;
    expect(r.error).toBe(grant);
  });

  it("turns an older extension's unknown-op refusal into the fix", async () => {
    // Web Store review lags a desktop release, so an extension that predates a
    // new op (visual, design, network_body) is an expected state.
    const stale =
      'the browser extension has no bridged op "visual". This build may be ' +
      "older than the desktop app asking.";
    requestMock.mockRejectedValueOnce(new Error(stale));
    const r = await requestChrome("visual", {});
    expect(isChromeRefusal(r)).toBe(true);
    if (!isChromeRefusal(r)) return;
    expect(r.error).toContain("older than this app");
    expect(r.error).toContain('"visual"');
    expect(r.error).toContain("chrome://extensions");
  });

  it("does not reach the extension at all when nothing is connected", async () => {
    connected.value = false;
    const r = await requestChrome("read_page", {});
    expect(isChromeRefusal(r)).toBe(true);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("no refusal invents a login requirement", () => {
  it("never mentions signing in", () => {
    serverPresent.value = false;
    const noRelay = chromeUnavailable()!.error;
    serverPresent.value = true;
    connected.value = false;
    const noBrowser = chromeUnavailable()!.error;
    const modes = ["xray"].map(
      (m) => (chromeInspectOp(m) as { error: string }).error,
    );
    for (const msg of [noRelay, noBrowser, ...modes]) {
      expect(msg).not.toMatch(
        /\bsign in\b|\blog in\b|\blogged in\b|\bsigned in to the extension\b/i,
      );
    }
    // The connected-browser message says the opposite, on purpose.
    expect(noBrowser).toContain("needs no sign-in of its own");
  });
});

describe("the iframe disagreement is surfaced, not resolved", () => {
  it("adds a note when a Chrome read comes back near-empty", () => {
    expect(noteIfThin("   ")).toContain("top frame");
    expect(noteIfThin("   ")).toContain('mode:"visual"');
  });

  it("stays quiet on a normal read", () => {
    expect(noteIfThin("a".repeat(400))).toBeUndefined();
  });
});

/**
 * Pinned because it is a product decision that reads as an accident. `browser`
 * is `isReadOnly: false`, which is normally what excludes a tool from
 * Explore/Review — it survives because it mutates the open PAGE and never the
 * workspace, so those modes' filesystem rule is untouched. Someone tidying the
 * read-only modes would drop it without realising that is a capability change.
 *
 * PLAN IS NOW THE EXCEPTION, and deliberately so. Driving and reading a running
 * app is verification; Plan decides what should be done and writes "verify X in
 * Explore" as a step. The deciding fact was that `browser_inspect` cannot
 * navigate — keeping only the cheaper of the pair would have left Plan able to
 * inspect whatever page happened to be open and unable to open one, which is a
 * worse trap than having neither. See mode-tool-registry.ts for the full
 * argument and the measured cost.
 */
describe("mode availability", () => {
  const BROWSER_MODES = ["ask", "build", "debug", "review"] as const;

  it.each(["browser", "browser_inspect"])(
    "%s is offered in Explore, Review, Build and Debug — but not Plan",
    (tool) => {
      for (const mode of BROWSER_MODES) {
        expect(isToolAllowedInMode(tool, mode)).toBe(true);
      }
      // Both halves of the pair, together. Plan holding one without the other
      // is the trap this asserts against, not merely the token cost.
      expect(isToolAllowedInMode(tool, "plan")).toBe(false);
    },
  );

});
