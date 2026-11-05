/**
 * The seam between the browser tools and the user's Chrome.
 *
 * Since v14.52.0 the agent has ONE browser: the user's own Chrome (or Edge /
 * Brave), driven through the Atlarix extension over the native-messaging
 * bridge. The in-app agent browser is gone; Atlarix's hidden Chromium now only
 * serves web search. This module owns "can Chrome serve this, and if not, what
 * do we tell the model".
 *
 * ══ EVERY FAILURE IS A RESULT, NOT A THROW ══
 *
 * A thrown error ends the step and the model gets a stack it cannot act on. A
 * returned `{success:false, error}` lets it recover inside the same turn, so
 * each refusal below NAMES its cause and the next move. There is no other
 * browser to fall back to any more, so the next move is either a different
 * approach on this page or something the user has to do (open Chrome, install
 * or update the extension).
 *
 * ══ WHAT IS DELIBERATELY ABSENT ══
 *
 * There is no "you are not signed in" refusal, because it would be unreachable.
 * `chat_stream_handlers.ts` calls `requireAuthSession()` at the top of every
 * turn before any tool runs, and it is provider-agnostic — BYOK is gated
 * exactly like Core. The one bypass (`ATLARIX_HEADLESS=1`) drops every browser
 * tool via `DRIVES_A_VIEW` in `resolve-toolset.ts`. The extension needs no
 * sign-in of its own (`bridge/serve.ts` imports no auth, enforced by
 * `bridge-imports.test.ts`), and the bridge has no plan gate: it works on the
 * free plan. Only the extension's own side-panel agent is paid.
 *
 * ══ IT WORKS IN ITS OWN TAB GROUP, BESIDE THE USER ══
 *
 * Everything lands in Atlarix's own (emerald, titled) tab group: `navigate`
 * reuses the agent's tab, `open_tab` creates inside the group, no op ever
 * activates a tab, and `close_tab` refuses a tab the agent did not open. So a
 * turn can read and act while the user keeps working in their own tabs.
 * Acting on the user's current tab is still possible, but it has to be asked
 * for by `tab_id` from a tabs listing, which flags `active` and `agent`.
 */

import { bridge } from "@/main/bridge-lifecycle";
import { CHROME_STORE_URL } from "@/lib/bridge/host-install";

/** Every `browser_inspect` mode, and the bridged op that serves it. */
const INSPECT_OPS: Record<string, string> = {
  read: "read_page",
  snapshot: "read_page",
  text: "text",
  visual: "visual",
  design: "design",
  // The agent's own tabs over CDP; the user's tab only while it is the one on
  // screen (see the extension's `screenshot` op).
  screenshot: "screenshot",
  // Captured over CDP on the agent's own tabs from before their first load.
  console: "console",
  network: "network",
};

/** Every `browser` action, and the bridged op that serves it. */
const ACTION_OPS: Record<string, string> = {
  find: "find_on_page",
  click: "click",
  fill: "fill",
  scroll: "scroll",
  navigate: "navigate",
  tabs: "list_tabs", // the operation decides the real op; see `chromeTabsOp`
  batch: "batch", // sequenced on the desktop, step by step
  // Real keystrokes and pointer moves, over `chrome.debugger`. Only on tabs
  // Atlarix opened — the extension refuses the user's own tab by name, because
  // attaching banners the tab and evicts DevTools from it.
  key: "key",
  hover: "hover",
};

export interface ChromeRefusal {
  success: false;
  error: string;
}

/** Shape a refusal the way every other browser-tool failure is shaped. */
function refuse(error: string): ChromeRefusal {
  return { success: false, error };
}

/**
 * Can the bridge serve anything at all right now?
 *
 * Returns null when it can. The two failing states are genuinely different and
 * a user can only act on one of them, so they do not share a message.
 */
export function chromeUnavailable(): ChromeRefusal | null {
  const server = bridge();
  if (!server) {
    return refuse(
      "This build of Atlarix has no browser bridge — the native relay it needs " +
        "is not installed, so it cannot drive a browser. Tell the user; " +
        "reinstalling Atlarix restores it. Web research still works through " +
        "web_search and read_url.",
    );
  }
  if (!server.connected) {
    // NOT DISTINGUISHABLE FROM HERE, and saying so is better than guessing.
    // "extension not installed", "browser closed" and "worker asleep" all
    // present as zero peers, because the browser opens this connection — the
    // app cannot reach out and probe for it. One message covers all three and
    // orders the steps so the cheapest check comes first.
    return refuse(
      "No browser is connected to Atlarix. The agent's browser is the user's " +
        "own browser, driven through the Atlarix extension. Tell " +
        "the user to check, in this order: (1) is the browser running? (2) is " +
        "the Atlarix extension installed — it is free at " +
        `${CHROME_STORE_URL}; (3) if both, click the Atlarix icon in the ` +
        "browser once to wake it. Settings → Browser in Atlarix shows whether " +
        "it is connected. It needs no sign-in of its own. Meanwhile, web_search " +
        "and read_url still work for reading public pages.",
    );
  }
  return null;
}

/** The bridged op for a `browser_inspect` mode, or a refusal. */
export function chromeInspectOp(mode: string): string | ChromeRefusal {
  const op = INSPECT_OPS[mode];
  if (op) return op;
  return refuse(
    `Unknown mode "${mode}". Omit mode for the default read, or use "text", ` +
      `"visual", "design", "screenshot", "console" or "network".`,
  );
}

/** The bridged op for a `browser` action, or a refusal. */
export function chromeActionOp(action: string): string | ChromeRefusal {
  const op = ACTION_OPS[action];
  if (op) return op;
  return refuse(
    `Unknown action "${action}". Use navigate, find, click, fill, key, hover, ` +
      `scroll, tabs, or batch. (The five retired browser_* tools are now ` +
      `actions on this one tool.)`,
  );
}

/** `tabs` sub-operations; `switch` has no op, and says so rather than no-opping. */
export function chromeTabsOp(operation: string): string | ChromeRefusal {
  switch (operation) {
    case "list":
      return "list_tabs";
    case "create":
      return "open_tab";
    case "close":
      return "close_tab";
    case "switch":
      return refuse(
        'tabs operation:"switch" is not available — the agent never takes ' +
          "focus away from whatever the user is doing in their own browser. " +
          "Every call already takes a tab_id: pass the one you want to work in.",
      );
    default:
      return refuse(`unknown tabs operation "${operation}"`);
  }
}

/**
 * Ask the extension to do one thing.
 *
 * The extension's own errors are surfaced VERBATIM rather than re-worded. Two
 * of them are the most actionable messages in the whole system and were written
 * to be read by whoever is blocked: the site-grant refusal names the origin and
 * says a grant needs a click in the browser, and the unknown-op refusal says the
 * extension build may be older than the app asking — which is exactly what a
 * user still on 1.0.0 sees if a turn asks for the `text` op.
 */
export async function requestChrome(
  op: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: true; result: unknown } | ChromeRefusal> {
  const blocked = chromeUnavailable();
  if (blocked) return blocked;
  try {
    const result = await bridge()!.request(op, args);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An extension older than this app answers a new op with "has no bridged
    // op". Web Store review lags a desktop release by days, so this is an
    // expected state, not a bug — say what fixes it.
    if (/has no bridged op/.test(message)) {
      return refuse(
        `The Atlarix extension in the user's browser is older than this app ` +
          `and cannot do "${op}" yet. Everything else still works. Chrome ` +
          `updates extensions on its own within a day; the user can force it ` +
          `at chrome://extensions (Developer mode → Update).`,
      );
    }
    return refuse(message);
  }
}

/** The first extension build whose `open_tab` opens a blank tab when given no url. */
const BLANK_TAB_SINCE = [14, 52, 3];

/**
 * Can the connected extension open a blank tab?
 *
 * Asked BEFORE sending, not learned from a refusal: an older build answers an
 * empty `open_tab` with "needs an http(s) URL", which is the right answer to a
 * question the model did not mean to ask. An unknown version counts as old.
 */
export function chromeOpensBlankTabs(): boolean {
  const version = bridge()?.activeHello?.extensionVersion;
  if (typeof version !== "string") return false;
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < BLANK_TAB_SINCE.length; i++) {
    const have = Number.isFinite(parts[i]) ? parts[i]! : 0;
    if (have !== BLANK_TAB_SINCE[i]) return have > BLANK_TAB_SINCE[i]!;
  }
  return true;
}

export function isChromeRefusal(v: unknown): v is ChromeRefusal {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as ChromeRefusal).success === false &&
    typeof (v as ChromeRefusal).error === "string"
  );
}

/**
 * A Chrome read that came back with almost nothing may be an iframe page.
 *
 * The extension injects with `allFrames:false`, so a document whose content
 * lives in an iframe returns a near-empty result that looks exactly like a blank
 * page — and a model told "the page is empty" will report that to the user as
 * fact. This appends the alternative rather than deciding between them.
 */
const THIN_RESULT_CHARS = 40;

export function noteIfThin(text: string): string | undefined {
  if (text.trim().length > THIN_RESULT_CHARS) return undefined;
  return (
    "This page returned almost no content. The extension reads the top frame " +
    "only, so a page whose content sits in an iframe looks empty here even " +
    "when it is not. Before reporting the page as blank, take a screenshot or " +
    'use mode:"visual" to see what is actually rendered.'
  );
}
