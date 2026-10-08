/**
 * The MV3 service worker — the extension's only always-addressable context.
 *
 * WHAT IT IS NOT. It is not where work lives. Chrome terminates this worker
 * after roughly 30 seconds idle, and nothing here may assume it survives
 * between two events. That single fact decides most of the extension's shape:
 *
 *   - No refresh TIMER for the Supabase session. A timer scheduled here is
 *     killed with the worker and the token quietly rots. Refresh happens on
 *     demand instead, checked against `exp` before each call.
 *   - No sign-in. `launchWebAuthFlow` holds a promise open for as long as the
 *     user looks at a consent screen, which is routinely longer than the worker
 *     lives. Sign-in runs in the side panel, which is an ordinary document with
 *     an ordinary lifetime.
 *   - No agent loop. That lands in the offscreen document, for the same reason.
 *
 * What DOES belong here is exactly what must be addressable from anywhere and
 * owned by one context: the single-flight token refresh (Supabase rotates
 * refresh tokens, so two concurrent refreshes race and the loser's
 * `400 invalid_grant` presents to the user as a spontaneous logout), and the
 * message router other contexts ask through.
 */

import { api } from "../shared/browser-api";
import { connectBridge, installBridgeAlarm, sendExtRequest } from "../bridge/native-port";
import { redrawBadge } from "../peers/inbox";

// ---------------------------------------------------------------------------
// The desktop bridge — FIRST, and the order is the bug fix
// ---------------------------------------------------------------------------

/**
 * Opened at the TOP LEVEL, not from an install or startup event.
 *
 * A service worker is re-entered from scratch every time Chrome wakes it, and
 * `onInstalled` fires once in the extension's life while `onStartup` fires only
 * for a profile launch. Neither runs on the ordinary wake — a tab event, an
 * alarm, a panel opening — so a bridge connected from either would be absent
 * for most of the worker's actual lifetimes. Top level runs on every one.
 *
 * Cheap when there is nothing to connect to: `connectNative` throws immediately
 * if no host manifest is installed, which is the state for everyone who has the
 * extension and not the desktop app.
 */
installBridgeAlarm();
connectBridge();

/**
 * ...AND a startup listener, for a different reason than connecting.
 *
 * The top-level call above runs whenever the worker runs — but after a browser
 * LAUNCH nothing may run it: with no tab event, alarm or panel, the worker
 * stays asleep and the desktop sees "no browser connected" until the user
 * happens to touch something. A registered `onStartup` listener is what makes
 * Chrome wake the worker at profile launch; the handler itself is just the
 * idempotent connect. Guarded like the panel wiring below, so a browser without
 * the event can never take the bridge down.
 */
try {
  api().runtime.onStartup.addListener(() => connectBridge());
} catch {
  /* no onStartup in this browser — the alarm reconnects within a minute */
}

// ---------------------------------------------------------------------------
// Opening the panel
// ---------------------------------------------------------------------------

/**
 * Clicking the toolbar icon opens the side panel — or a window, where there is
 * no side panel to open.
 *
 * ══ WHY THIS IS BELOW THE BRIDGE AND WRAPPED, NOT AT THE TOP ══
 *
 * It used to be the worker's FIRST statement, written as
 * `api().sidePanel.setPanelBehavior({…}).catch(log)`. In a Chromium fork with
 * no `chrome.sidePanel` — Arc is the reported case — `api().sidePanel` is
 * undefined and reading `.setPanelBehavior` throws a SYNCHRONOUS TypeError. The
 * `.catch()` could never fire: it is chained onto the result of a call that
 * never happened. Module evaluation aborted on line one, so `connectBridge()`
 * below never ran and the extension was not panel-less, it was INERT. The user
 * report was "it downloaded, but it didn't turn on", and that is exactly right.
 *
 * Two things follow, and the first matters more than the fallback:
 *
 *   1. The bridge starts BEFORE any of this. Panel wiring is presentation; a
 *      browser quirk in it must never be able to take the desktop connection
 *      down with it. Ordering is the fix; the try/catch is the belt.
 *   2. Feature-detect rather than assume. `browser-api.ts` now types
 *      `sidePanel` as optional, so this class of mistake is a type error.
 *
 * ══ WHY `onClicked` IS AVAILABLE EXACTLY WHEN IT IS NEEDED ══
 *
 * `action.onClicked` fires only when the action has neither a `default_popup`
 * nor a registered panel behaviour. The manifest deliberately has no popup (it
 * would consume the click and the panel would never open), so in a browser
 * without `sidePanel` there is no behaviour to register either — which is the
 * one situation where `onClicked` fires. The fallback is there precisely when
 * the thing it replaces is not.
 *
 * Registered at top level rather than in `onInstalled`: the worker is recreated
 * after every termination, so this has to re-register each time.
 */
function wirePanelOpening(): void {
  try {
    const ns = api();
    const panel = ns.sidePanel;
    if (panel?.setPanelBehavior) {
      void panel
        .setPanelBehavior({ openPanelOnActionClick: true })
        .catch((err: unknown) => {
          console.error("[atlarix] sidePanel.setPanelBehavior failed", err);
        });
      return;
    }

    // No side panel in this browser. Open the same document in a window.
    ns.action?.onClicked.addListener(() => {
      void ns.windows
        .create({
          url: ns.runtime.getURL("sidepanel.html"),
          type: "popup",
          width: 460,
          height: 760,
        })
        .catch((err: unknown) => {
          console.error("[atlarix] could not open the panel window", err);
        });
    });
    console.info(
      "[atlarix] no chrome.sidePanel in this browser — the toolbar button " +
        "opens Atlarix in a window instead.",
    );
  } catch (err) {
    // Nothing about opening a panel may break the worker. The bridge is already
    // connected by the time this runs, and that is the point.
    console.error("[atlarix] panel wiring failed", err);
  }
}

wirePanelOpening();

// ---------------------------------------------------------------------------
// Replies to other Atlarix sessions
// ---------------------------------------------------------------------------

/**
 * The panel's one way to the desktop. The native port lives HERE, in the
 * worker, so when the side-panel agent lists or messages the user's Atlarix
 * sessions (tools/dispatch.ts `list_sessions`, `send_message`), it asks
 * through this router.
 *
 * Narrow on purpose: two message types, from this extension's own pages only
 * (`sender.id`), carrying only `to` and `text`. Who it is from is written by
 * the desktop, not here (desktop lib/peers/chrome-peer.ts).
 */
try {
  api().runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const m = (message ?? {}) as { type?: string; to?: unknown; text?: unknown };
    if (m.type !== "atlarix:peer-send" && m.type !== "atlarix:peer-list") return undefined;
    if (sender?.id && sender.id !== api().runtime.id) return undefined;
    const request =
      m.type === "atlarix:peer-list"
        ? sendExtRequest("peer_list", {})
        : sendExtRequest("peer_send", {
            to: typeof m.to === "string" ? m.to : "",
            text: typeof m.text === "string" ? m.text : "",
          });
    request.then(
      (result) => sendResponse({ ok: true, result }),
      (err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // answered asynchronously
  });
} catch (err) {
  console.error("[atlarix] message router failed", err);
}

// The badge does not survive a browser restart on its own; the inbox does.
void redrawBadge();
