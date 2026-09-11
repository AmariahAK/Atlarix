/**
 * Which browser are we in, and what can it actually do.
 *
 * THE TARGET IS CHROMIUM, NOT CHROME. Chrome, Edge and Brave take one build:
 * same `chrome.*` namespace, same manifest, only the store listing differs.
 * Firefox is a different matter and this module exists to keep that honest —
 * four APIs this extension leans on are missing there, and the failure mode
 * without a probe is a button that throws instead of one that is absent.
 *
 *   `debugger`   — absent, and there is NO equivalent. It is the only way to
 *                  emit `isTrusted=true` events; Mozilla's own request for one
 *                  (Bugzilla 1348213) is still open. Without it `key` and
 *                  `hover` cannot work at all, for the reason recorded at
 *                  `src/lib/tools/browser.ts:1173` — Enter-to-submit and CSS
 *                  `:hover` fire for trusted events only, and a synthetic
 *                  KeyboardEvent "looks right in code and silently does nothing".
 *   `tabGroups`  — absent. It is our status surface, our stop gesture AND the
 *                  boundary between the agent's tabs and the user's.
 *   `offscreen`  — Chrome-only. It is where the agent loop lives.
 *   `sidePanel`  — Firefox has `sidebarAction`: per-window, manifest-declared,
 *                  not per-tab.
 *
 * Safari is a separate codebase and a separate store, and is not modelled here.
 *
 * WHAT IS ALREADY PORTABLE, and must stay that way: the page-realm scripts, the
 * permission classifier, the site-grant store, PKCE, and the agent loop. A
 * Firefox build should be adapters over those, never a fork of them. Reach for
 * the API through this module rather than the global so that stays true.
 */

/**
 * The subset of the extension API namespace we touch.
 *
 * Spelled out rather than `typeof chrome` so that (a) `debugger` can be named at
 * all — it is a keyword, legal as a property but not as a namespace — and (b)
 * adding a capability is a visible edit here, not an accident of what happens to
 * be declared in the ambient file.
 */
interface ExtensionApi {
  runtime: typeof chrome.runtime;
  identity: typeof chrome.identity;
  storage: typeof chrome.storage;
  tabs: typeof chrome.tabs;
  tabGroups: typeof chrome.tabGroups;
  scripting: typeof chrome.scripting;
  debugger: typeof chrome._debugger;
  offscreen: typeof chrome.offscreen;
  sidePanel: typeof chrome.sidePanel;
  windows: typeof chrome.windows;
}

interface ApiCarrier {
  chrome?: ExtensionApi;
  /** Firefox's promise-based namespace; Chromium does not define it. */
  browser?: ExtensionApi;
}

/**
 * The extension API namespace, whatever this browser calls it.
 *
 * Firefox defines BOTH: `browser.*` returns promises, `chrome.*` is the
 * callback-style compatibility shim. Preferring `browser` therefore gets the
 * promise API on Firefox and is simply undefined on Chromium — which is the
 * behaviour we want, since every call site here is `await`ed.
 */
export function api(): ExtensionApi {
  const g = globalThis as unknown as ApiCarrier;
  const ns = g.browser ?? g.chrome;
  if (!ns) {
    throw new Error(
      "No extension API namespace found (neither `browser` nor `chrome`). " +
        "This module must run in an extension context — a content script, the " +
        "service worker, the side panel, or the offscreen document.",
    );
  }
  return ns;
}

/** True when running inside an extension context at all. */
export function hasExtensionApi(): boolean {
  const g = globalThis as unknown as ApiCarrier;
  return Boolean(g.browser ?? g.chrome);
}

export interface BrowserCapabilities {
  /** `chrome.debugger` — trusted input. Without it, `key` and `hover` are lost. */
  trustedInput: boolean;
  /** `chrome.tabGroups` — the agent's visible boundary and stop gesture. */
  tabGroups: boolean;
  /** `chrome.offscreen` — the long-lived document the agent loop runs in. */
  offscreenDocument: boolean;
  /** `chrome.sidePanel`. Firefox has `sidebarAction`, which is not the same. */
  sidePanel: boolean;
}

/**
 * Probe once, at startup. Feature detection rather than a user-agent string:
 * Edge and Brave both identify as Chrome, and a browser that GAINS an API
 * should light it up without us shipping a new allowlist.
 */
export function detectCapabilities(): BrowserCapabilities {
  const ns = hasExtensionApi()
    ? (api() as unknown as Record<string, unknown>)
    : {};
  return {
    trustedInput: Boolean(ns.debugger),
    tabGroups: Boolean(ns.tabGroups),
    offscreenDocument: Boolean(ns.offscreen),
    sidePanel: Boolean(ns.sidePanel),
  };
}

/** Every capability this build requires to deliver the full tool contract. */
const REQUIRED: readonly (keyof BrowserCapabilities)[] = [
  "trustedInput",
  "tabGroups",
  "offscreenDocument",
];

/**
 * The capabilities this browser is missing, as tool-contract terms.
 *
 * Used to DEGRADE LOUDLY. A `key` action on a browser without trusted input
 * must fail saying so and naming Atlarix's own browser as the way to get it —
 * never dispatch a synthetic event and report success, which is the silent
 * failure the whole design exists to avoid.
 */
export function missingCapabilities(
  caps: BrowserCapabilities = detectCapabilities(),
): (keyof BrowserCapabilities)[] {
  return REQUIRED.filter((k) => !caps[k]);
}

export function isFullySupported(
  caps: BrowserCapabilities = detectCapabilities(),
): boolean {
  return missingCapabilities(caps).length === 0;
}

/** Why an action is unavailable here, in words the model can act on. */
export function unsupportedActionMessage(
  action: string,
  capability: keyof BrowserCapabilities,
): string {
  if (capability === "trustedInput") {
    return (
      `action:"${action}" needs trusted keyboard/pointer input, which this browser ` +
      `does not expose to extensions. Nothing was done — a synthetic event would ` +
      `look like it worked and silently do nothing. Open the page in Atlarix's ` +
      `built-in browser (target:"app") for the full action set.`
    );
  }
  return (
    `action:"${action}" is unavailable in this browser (missing ${capability}). ` +
    `Nothing was done. Try target:"app" for Atlarix's built-in browser.`
  );
}
