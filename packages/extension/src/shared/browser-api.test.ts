/**
 * Capability probing — the thing that keeps "works in Chrome" from silently
 * meaning "broken in Brave" or "half-broken in Firefox".
 *
 * Feature detection, never a user-agent string: Edge and Brave both identify as
 * Chrome, so a UA allowlist would be wrong on day one, and a browser that GAINS
 * an API should light it up without us shipping a new build.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  api,
  detectCapabilities,
  hasExtensionApi,
  isFullySupported,
  missingCapabilities,
  unsupportedActionMessage,
} from "./browser-api";

const g = globalThis as Record<string, unknown>;

/** What Chrome, Edge and Brave all expose — one build covers the three. */
const CHROMIUM = {
  runtime: {},
  storage: {},
  tabs: {},
  debugger: {},
  tabGroups: {},
  offscreen: {},
  sidePanel: {},
  scripting: {},
};

/**
 * Firefox, as measured: no `debugger` (and no equivalent — it is the only way to
 * emit isTrusted=true events, Bugzilla 1348213 is still open), no `tabGroups`,
 * no `offscreen`, and `sidebarAction` in place of `sidePanel`.
 */
const FIREFOX = {
  runtime: {},
  storage: {},
  tabs: {},
  scripting: {},
  sidebarAction: {},
};

afterEach(() => {
  delete g.chrome;
  delete g.browser;
});

describe("namespace resolution", () => {
  it("finds the Chromium namespace", () => {
    g.chrome = CHROMIUM;
    expect(hasExtensionApi()).toBe(true);
    expect(api()).toBe(CHROMIUM);
  });

  it("prefers Firefox's promise-based `browser` when both exist", () => {
    // Firefox defines both; `chrome` there is the callback-style shim, and every
    // call site in this package is awaited.
    g.chrome = { runtime: {} };
    g.browser = FIREFOX;
    expect(api()).toBe(FIREFOX);
  });

  it("throws a message that says where this code must run", () => {
    expect(hasExtensionApi()).toBe(false);
    expect(() => api()).toThrow(
      /content script|service worker|side panel|offscreen/i,
    );
  });
});

describe("capabilities", () => {
  it("reports a Chromium browser as fully supported", () => {
    g.chrome = CHROMIUM;
    expect(detectCapabilities()).toEqual({
      trustedInput: true,
      tabGroups: true,
      offscreenDocument: true,
      sidePanel: true,
    });
    expect(missingCapabilities()).toEqual([]);
    expect(isFullySupported()).toBe(true);
  });

  it("reports exactly what Firefox is missing", () => {
    g.browser = FIREFOX;
    const caps = detectCapabilities();
    expect(caps.trustedInput).toBe(false);
    expect(caps.tabGroups).toBe(false);
    expect(caps.offscreenDocument).toBe(false);
    // `sidebarAction` is not `sidePanel`; per-window, not per-tab.
    expect(caps.sidePanel).toBe(false);
    expect(missingCapabilities(caps).sort()).toEqual([
      "offscreenDocument",
      "tabGroups",
      "trustedInput",
    ]);
    expect(isFullySupported(caps)).toBe(false);
  });

  it("does not require sidePanel — a sidebar is a substitutable host", () => {
    // The chat UI ports to `sidebarAction`; the agent loop ports to nothing at
    // all without an offscreen document. Only the latter is required.
    g.chrome = { ...CHROMIUM, sidePanel: undefined };
    expect(detectCapabilities().sidePanel).toBe(false);
    expect(missingCapabilities()).toEqual([]);
    expect(isFullySupported()).toBe(true);
  });

  it("does not throw outside an extension context", () => {
    expect(() => detectCapabilities()).not.toThrow();
    expect(detectCapabilities().trustedInput).toBe(false);
  });
});

describe("degrading loudly", () => {
  it("explains a missing trusted-input action without claiming it worked", () => {
    const msg = unsupportedActionMessage("key", "trustedInput");
    expect(msg).toMatch(/nothing was done/i);
    // The honest fallback: Atlarix's own browser has the full action set.
    expect(msg).toContain('target:"app"');
    // And it must say WHY, or the model will just retry the same call.
    expect(msg).toMatch(/silently do nothing|trusted/i);
  });

  it("names the missing capability for anything else", () => {
    const msg = unsupportedActionMessage("tabs", "tabGroups");
    expect(msg).toContain("tabGroups");
    expect(msg).toMatch(/nothing was done/i);
  });
});
