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
  capabilityStates,
  detectCapabilities,
  hasExtensionApi,
  isFullySupported,
  missingCapabilities,
  notYetRequested,
  unsupportedActionMessage,
} from "./browser-api";

const g = globalThis as Record<string, unknown>;

/** A `runtime` whose `getManifest` reports the given `permissions`. */
function runtimeAsking(...permissions: string[]) {
  return { getManifest: () => ({ permissions }) };
}

/** Everything declared — what the manifest looks like once Phase 1 is done. */
const ALL_PERMISSIONS = runtimeAsking(
  "identity",
  "storage",
  "sidePanel",
  "debugger",
  "tabGroups",
  "offscreen",
);

/** What Chrome, Edge and Brave all expose — one build covers the three. */
const CHROMIUM = {
  runtime: ALL_PERMISSIONS,
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
  runtime: ALL_PERMISSIONS,
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
    // `offscreenDocument` is deliberately NOT here. It was required on the
    // belief that the agent loop needed one; the loop runs in the side panel,
    // and nothing has ever called `chrome.offscreen`. A required capability
    // nothing requires tells a browser it cannot run software that would work.
    expect(missingCapabilities(caps).sort()).toEqual([
      "tabGroups",
      "trustedInput",
    ]);
    expect(isFullySupported(caps)).toBe(false);
  });

  it("does not require sidePanel — a sidebar is a substitutable host", () => {
    // The chat UI ports to `sidebarAction`, which hosts a document just as the
    // loop needs. What does not port is trusted input: Firefox has no
    // `chrome.debugger` equivalent and Bugzilla 1348213 is still open.
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

/**
 * The bug this file shipped with, observed on the first real unpacked load
 * (2026-09-12): a healthy Chrome was told it was "missing: trustedInput,
 * tabGroups, offscreenDocument".
 *
 * `chrome.debugger`, `chrome.tabGroups` and `chrome.offscreen` do not exist
 * until the manifest DECLARES the permission, and this build adds them one at a
 * time with their first caller. So bare feature detection cannot tell a browser
 * that cannot from a build that has not asked — and it reported the wrong one.
 * A loud degrade that says something false is worse than a quiet one: it sends
 * the reader to debug their browser instead of reading our manifest.
 */
describe("not-requested is not the same as unsupported", () => {
  /** Phase 1's actual manifest: the namespaces are absent by our own choice. */
  const STAGED_CHROME = {
    runtime: runtimeAsking("identity", "storage", "sidePanel"),
    storage: {},
    sidePanel: {},
  };

  it("says nothing is missing on a Chrome we simply have not asked yet", () => {
    g.chrome = STAGED_CHROME;
    expect(missingCapabilities()).toEqual([]);
    expect(isFullySupported()).toBe(true);
  });

  it("still names them as not-requested, so a diagnostic can show the truth", () => {
    g.chrome = STAGED_CHROME;
    expect(notYetRequested().sort()).toEqual(["tabGroups", "trustedInput"]);
    expect(capabilityStates()).toEqual({
      trustedInput: "not-requested",
      tabGroups: "not-requested",
      offscreenDocument: "not-requested",
      sidePanel: "granted",
    });
  });

  it("still calls Firefox unsupported — it was asked and could not", () => {
    g.browser = FIREFOX;
    expect(capabilityStates().trustedInput).toBe("unsupported");
    expect(notYetRequested()).toEqual([]);
    expect(missingCapabilities().sort()).toEqual(["tabGroups", "trustedInput"]);
  });

  it("reports a real gap when the manifest cannot be read", () => {
    // No `getManifest` means the two cases are indistinguishable, and the safe
    // reading is the pessimistic one — never quietly excuse a genuine gap as
    // "we did not ask for it".
    g.chrome = { runtime: {}, storage: {} };
    expect(capabilityStates().trustedInput).toBe("unsupported");
    expect(missingCapabilities()).toContain("trustedInput");
  });

  it("survives a getManifest that throws or returns no permissions", () => {
    g.chrome = {
      runtime: {
        getManifest: () => {
          throw new Error("nope");
        },
      },
    };
    expect(() => capabilityStates()).not.toThrow();
    expect(capabilityStates().tabGroups).toBe("unsupported");

    delete g.chrome;
    g.chrome = { runtime: { getManifest: () => ({}) } };
    expect(capabilityStates().tabGroups).toBe("unsupported");
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
