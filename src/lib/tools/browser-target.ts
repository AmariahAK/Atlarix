/**
 * `target: "app" | "chrome"` — which browser a browser tool acts on.
 *
 * WHY THIS IS ITS OWN MODULE. `browser.ts` has 46 `webContents` call sites and
 * every one of them means Atlarix's own `WebContentsView`. Threading `bridge()`
 * through them would put a null check in front of each and make the extension
 * path a second meaning for the same code. Instead the seam is here: one place
 * that owns "can Chrome serve this, and if not, what do we tell the model".
 *
 * ══ EVERY FAILURE IS A RESULT, NOT A THROW ══
 *
 * A thrown error ends the step and the model gets a stack it cannot act on. A
 * returned `{success:false, error}` lets it recover inside the same turn — and
 * in almost every case here the recovery is the same one sentence: retry with
 * `target:"app"`. That is why each refusal below NAMES its cause and names the
 * next move, rather than reporting that something went wrong.
 *
 * ══ WHAT IS DELIBERATELY ABSENT ══
 *
 * There is no "you are not signed in" refusal, because it would be unreachable.
 * `chat_stream_handlers.ts` calls `requireAuthSession()` at the top of every
 * turn before any tool runs, and it is provider-agnostic — BYOK is gated
 * exactly like Core. The one bypass (`ATLARIX_HEADLESS=1`) drops every browser
 * tool via `DRIVES_A_VIEW` in `resolve-toolset.ts`. So a browser tool only ever
 * executes inside an authenticated turn, and a refusal naming a login would
 * send the user hunting for a sign-in that is not the problem.
 *
 * The extension itself needs no sign-in of its own: `bridge/serve.ts` imports
 * no auth and no model client, enforced by `bridge-imports.test.ts`. It rides
 * the account the desktop app is already signed into.
 *
 * ══ IT WORKS IN ITS OWN TAB GROUP, BESIDE THE USER ══
 *
 * Everything on this path lands in Atlarix's own (emerald, titled) tab group:
 * `navigate` reuses the agent's tab, `open_tab` creates inside the group, no op
 * ever activates a tab, and `close_tab` refuses a tab the agent did not open.
 * So a turn can read and act while the user keeps working in their own tabs —
 * nothing takes focus and nothing navigates out from under them. Acting on the
 * user's current tab is still possible, but it has to be asked for by `tab_id`
 * from a tabs listing, which flags `active` and `agent`.
 */

import { bridge } from "@/main/bridge-lifecycle";
import { CHROME_STORE_URL } from "@/lib/bridge/host-install";

export type BrowserTarget = "app" | "chrome";

/** Every `browser_inspect` mode, and the bridged op that serves it — or null. */
const INSPECT_OPS: Record<string, string | null> = {
  read: "read_page",
  snapshot: "read_page",
  text: "text",
  visual: null,
  design: null,
  // Since 2026-09-23: the agent's own tabs over CDP, the user's tab only while
  // it is the one on screen (see the extension's `screenshot` op).
  screenshot: "screenshot",
  // Captured over CDP on the agent's own tabs since 2026-09-17. They were
  // `null` here with a reason claiming the extension COULD not do this; it
  // could, and had held the `debugger` permission all along.
  console: "console",
  network: "network",
};

/** Every `browser` action, and the bridged op that serves it — or null. */
const ACTION_OPS: Record<string, string | null> = {
  find: "find_on_page",
  click: "click",
  fill: "fill",
  scroll: "scroll",
  navigate: "navigate",
  tabs: "list_tabs", // the operation decides the real op; see `chromeTabsOp`
  batch: "batch", // sequenced here, step by step
  // Real keystrokes and pointer moves, over `chrome.debugger`. Only on tabs
  // Atlarix opened — the extension refuses the user's own tab by name, because
  // attaching banners the tab and evicts DevTools from it.
  key: "key",
  hover: "hover",
};

/**
 * Why a mode or action cannot cross the bridge.
 *
 * Each names the missing capability rather than saying "unsupported", because
 * the model's next move differs: a console read has no Chrome equivalent at all
 * and must go back to the app, while a hover simply has no op yet.
 */
/**
 * WRITE "THIS BUILD DOES NOT", NEVER "THIS CANNOT".
 *
 * Twice now a refusal here has described an unwritten feature as an impossible
 * one. `action:"key"` said "the extension has no key-press op" while `pressKey`
 * sat one import away, and `mode:"console"` said it needed instrumentation only
 * the built-in browser installs while the extension held the `debugger`
 * permission and was already attaching CDP. Both sent the reader looking for a
 * feature to build instead of a case to add. A refusal describes THIS BUILD.
 */
const UNBRIDGED_REASON: Record<string, string> = {
  visual:
    "the visual report measures layout, contrast and CLS through instrumentation that only Atlarix's built-in browser installs",
  design:
    "the design report samples the rendered palette, type scale and layout regions through instrumentation that only Atlarix's built-in browser installs",
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
        "is not installed. Retry with target:\"app\" to use Atlarix's built-in " +
        "browser, which needs nothing extra.",
    );
  }
  if (!server.connected) {
    // NOT DISTINGUISHABLE FROM HERE, and saying so is better than guessing.
    // "extension not installed", "browser closed" and "side panel never opened"
    // all present as zero peers, because the browser opens this connection —
    // the app cannot reach out and probe for it. One message covers all three
    // and orders the steps so the cheapest check comes first.
    return refuse(
      "No browser is connected to Atlarix, so target:\"chrome\" cannot run. " +
        "Tell the user to check, in this order: (1) is Chrome, Brave or Edge " +
        "running? (2) is the Atlarix extension installed — if not, it is free " +
        `at ${CHROME_STORE_URL}; (3) open the Atlarix side panel in the browser ` +
        "once, which is what opens this connection — the app cannot open it " +
        "from its side. The extension needs no sign-in of its own; it uses the " +
        "account this app is already signed into. Meanwhile target:\"app\" " +
        "works with no extension at all.",
    );
  }
  return null;
}

/** The bridged op for a `browser_inspect` mode, or a refusal naming the gap. */
export function chromeInspectOp(mode: string): string | ChromeRefusal {
  const op = INSPECT_OPS[mode];
  if (op) return op;
  const why = UNBRIDGED_REASON[mode] ?? "the extension has no op for it";
  return refuse(
    `mode:"${mode}" is not available over the Chrome extension — ${why}. ` +
      `Retry the same call with target:"app" (Atlarix's built-in browser ` +
      `supports every mode), or say what you needed it for.`,
  );
}

/** The bridged op for a `browser` action, or a refusal naming the gap. */
export function chromeActionOp(action: string): string | ChromeRefusal {
  const op = ACTION_OPS[action];
  if (op) return op;
  const why = UNBRIDGED_REASON[action] ?? "the extension has no op for it";
  return refuse(
    `action:"${action}" is not available over the Chrome extension — ${why}. ` +
      `Retry with target:"app", which supports it.`,
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
        'tabs operation:"switch" is not available over the Chrome extension — ' +
          "it will not take focus away from whatever the user is doing in their " +
          "own browser. Read a specific tab instead by passing its tab_id, or " +
          'use target:"app".',
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
    return refuse(err instanceof Error ? err.message : String(err));
  }
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
    'when it is not. Before reporting the page as blank, retry with target:"app".'
  );
}
