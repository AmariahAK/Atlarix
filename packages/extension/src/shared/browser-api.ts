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
 *                  `hover` cannot work at all, for the reason recorded in
 *                  `src/lib/tools/browser.ts` under `key / hover / scroll`:
 *                  Enter-to-submit and CSS `:hover` fire for trusted events
 *                  only, and a synthetic KeyboardEvent "looks right in code
 *                  and silently does nothing".
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
  /** Optional host access, requested per origin at grant time. */
  permissions: typeof chrome.permissions;
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
 *
 * This answers only "is the namespace here". That is NOT the same question as
 * "can this browser do it" — see `capabilityStates`, which is what callers who
 * are about to say something to a user or a model should use.
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

/** The manifest permission each capability's namespace is gated behind. */
const PERMISSION_FOR: Record<keyof BrowserCapabilities, string> = {
  trustedInput: "debugger",
  tabGroups: "tabGroups",
  offscreenDocument: "offscreen",
  sidePanel: "sidePanel",
};

/**
 * Why a capability is unavailable — three states, not two.
 *
 *   `granted`        the namespace is here and usable.
 *   `not-requested`  THIS BUILD's manifest does not ask for the permission, so
 *                    the namespace is absent by our own choice. Says nothing
 *                    about the browser.
 *   `unsupported`    we asked and the browser did not provide it. A real gap —
 *                    Firefox, for everything but `scripting`.
 */
export type CapabilityState = "granted" | "not-requested" | "unsupported";

/**
 * WHY THIS EXISTS, and it is a bug this file shipped with.
 *
 * `chrome.debugger`, `chrome.tabGroups` and `chrome.offscreen` do not exist
 * unless the manifest DECLARES the matching permission. So bare feature
 * detection cannot tell a browser that cannot do something from a build that
 * has not asked yet — and the permissions are being added one commit at a time,
 * each with its first caller, so "has not asked yet" is the normal state for
 * most of Phase 1.
 *
 * Observed 2026-09-12 on the very first unpacked load: the side panel announced
 * "This browser is missing: trustedInput, tabGroups, offscreenDocument" on a
 * perfectly capable Chrome. A loud degrade that says the wrong thing is worse
 * than a silent one — it sends the reader to debug their browser.
 *
 * `runtime.getManifest()` needs no permission and is the ground truth for what
 * we asked for, so the two together give an answer worth printing.
 */
export function capabilityStates(
  caps: BrowserCapabilities = detectCapabilities(),
): Record<keyof BrowserCapabilities, CapabilityState> {
  const requested = requestedPermissions();
  const stateOf = (key: keyof BrowserCapabilities): CapabilityState => {
    if (caps[key]) return "granted";
    // When the manifest is unreadable we cannot distinguish, and the safe
    // reading is the pessimistic one: report a real gap rather than quietly
    // excusing it as "not asked for".
    if (requested && !requested.has(PERMISSION_FOR[key]))
      return "not-requested";
    return "unsupported";
  };
  return {
    trustedInput: stateOf("trustedInput"),
    tabGroups: stateOf("tabGroups"),
    offscreenDocument: stateOf("offscreenDocument"),
    sidePanel: stateOf("sidePanel"),
  };
}

/** The manifest's `permissions`, or null when it cannot be read. */
function requestedPermissions(): Set<string> | null {
  if (!hasExtensionApi()) return null;
  const getManifest = api().runtime?.getManifest;
  if (typeof getManifest !== "function") return null;
  try {
    const permissions = getManifest().permissions;
    return Array.isArray(permissions) ? new Set(permissions) : null;
  } catch {
    return null;
  }
}

/**
 * The capabilities this BROWSER cannot provide, as tool-contract terms.
 *
 * Used to DEGRADE LOUDLY. A `key` action on a browser without trusted input
 * must fail saying so and naming Atlarix's own browser as the way to get it —
 * never dispatch a synthetic event and report success, which is the silent
 * failure the whole design exists to avoid.
 *
 * Excludes anything this build simply has not requested: that is our own
 * staging, not a limitation to report to anyone. Use `notYetRequested` if you
 * specifically want that list.
 */
export function missingCapabilities(
  caps: BrowserCapabilities = detectCapabilities(),
): (keyof BrowserCapabilities)[] {
  const states = capabilityStates(caps);
  return REQUIRED.filter((k) => states[k] === "unsupported");
}

/**
 * Capabilities absent because this build's manifest does not ask for them.
 *
 * Expected during the staged permission rollout, and useful in a diagnostic —
 * but never phrased to a user as something their browser lacks.
 */
export function notYetRequested(
  caps: BrowserCapabilities = detectCapabilities(),
): (keyof BrowserCapabilities)[] {
  const states = capabilityStates(caps);
  return REQUIRED.filter((k) => states[k] === "not-requested");
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
