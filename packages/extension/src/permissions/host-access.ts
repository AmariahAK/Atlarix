/**
 * Host access — the half of a site grant that Chrome itself enforces.
 *
 * `site-grants.ts` records the user's INTENT, and its own docblock is honest
 * about the limit: `chrome.storage` is a LevelDB file any local process running
 * as the user can rewrite, so a record there is not a boundary. This module is
 * the boundary. Host access is a REQUIRED `host_permissions` entry as of
 * 2026-09-17 — the desktop app must never have to ask — so Chrome grants it at
 * install, and a user NARROWS it from chrome://extensions rather than widening
 * it from here. `hasHostAccess` therefore still answers honestly once someone
 * sets a site to "On click".
 *
 * THE TWO MUST BE WRITTEN IN THIS ORDER, and it is the whole point:
 *
 *     permissions.request()  ->  true  ->  grantSite()
 *
 * Never the reverse, and never the record alone. `request()` resolves FALSE
 * when the user declines — it does not reject — so a grant written first and
 * "confirmed" afterwards leaves a record claiming access Chrome never gave, and
 * every later read would trust it.
 *
 * WHY A USER GESTURE IS A FEATURE HERE. `request()` cannot be called from a
 * service worker and must come from inside a click. The agent loop runs in the
 * worker and the offscreen document, so it **structurally cannot widen its own
 * reach** — there is no code path from the loop to this API. That is worth more
 * than a rule saying it must not.
 */

import { api } from "../shared/browser-api";
import { grantSite, isGranted, originOf, revokeSite } from "./site-grants";

/**
 * The match pattern for an origin.
 *
 * Chrome wants `https://host/*`, not the bare origin — a pattern without a path
 * component is rejected outright, which surfaces as `request()` throwing rather
 * than resolving false.
 */
export function matchPatternFor(url: string): string | null {
  const origin = originOf(url);
  return origin ? `${origin}/*` : null;
}

/** Whether Chrome currently allows scripting this URL's origin. */
export async function hasHostAccess(url: string): Promise<boolean> {
  const pattern = matchPatternFor(url);
  if (!pattern) return false;
  return api().permissions.contains({ origins: [pattern] });
}

export type GrantOutcome =
  | { ok: true }
  | { ok: false; reason: "unsupported-scheme" | "declined" };

/**
 * Ask for a site, and record it only if Chrome actually granted it.
 *
 * MUST be called from a user gesture — a side-panel click. From anywhere else
 * Chrome rejects the request, and the extension would report "declined" for
 * something the user was never asked about.
 */
export async function requestHostAccess(url: string): Promise<GrantOutcome> {
  const pattern = matchPatternFor(url);
  // `originOf` returns null for anything that is not http(s) — a chrome://,
  // file:// or about: page. The manifest's host_permissions says the same
  // thing, so this is the code and the manifest agreeing rather than two
  // separate rules.
  if (!pattern) return { ok: false, reason: "unsupported-scheme" };

  const granted = await api().permissions.request({ origins: [pattern] });
  if (!granted) return { ok: false, reason: "declined" };

  await grantSite(url);
  return { ok: true };
}

/** Drop both halves. Leaving either behind is a lie about the other. */
export async function revokeHostAccess(url: string): Promise<void> {
  // CAUGHT, BECAUSE THIS CAN NO LONGER SUCCEED FOR THE BROAD PATTERNS.
  // `http://*/*` and `https://*/*` are REQUIRED host permissions as of
  // 2026-09-17, and Chrome refuses to let an extension give a required
  // permission back — an uncaught rejection here would turn the settings
  // "Revoke" button into an error. It is still attempted because a profile
  // upgraded from the optional era may hold narrow per-origin patterns that CAN
  // be dropped, and because the stored record below is what gates the panel.
  //
  // WHAT THIS NO LONGER DOES is stop the DESKTOP app. Nothing gates that path;
  // see `bridge/serve.ts`.
  const pattern = matchPatternFor(url);
  if (pattern) {
    await api()
      .permissions.remove({ origins: [pattern] })
      .catch(() => false);
  }
  await revokeSite(url);
}

/**
 * True only when BOTH halves agree.
 *
 * They can diverge in one direction that matters: the user revokes host access
 * from chrome://extensions, which Chrome does without telling us, leaving the
 * stored record behind. Trusting the record alone would have the agent attempt
 * an injection that fails with a permissions error the model cannot act on.
 * Asking Chrome as well turns that into an honest "not granted".
 */
export async function canActOn(url: string): Promise<boolean> {
  return (await hasHostAccess(url)) && (await isGranted(url));
}

/**
 * Reconcile the record with what Chrome actually holds.
 *
 * Call on panel open. A grant the browser has dropped should stop appearing in
 * our own settings list — otherwise the user sees a site they believe is
 * approved and we know is not.
 */
export async function pruneRevokedGrants(urls: string[]): Promise<string[]> {
  const dropped: string[] = [];
  for (const url of urls) {
    if (!(await hasHostAccess(url))) {
      await revokeSite(url);
      dropped.push(url);
    }
  }
  return dropped;
}

/** The two patterns that together mean "every page Atlarix can ever read". */
const ALL_SITES = ["http://*/*", "https://*/*"] as const;

/**
 * Does Chrome currently hold access to every site?
 *
 * Asked of Chrome rather than remembered, for the same reason `hasHostAccess`
 * is: the user can take it back from `chrome://extensions` and we are not told.
 * A stored "they said yes once" would outlive the answer.
 */
export async function hasAllSites(): Promise<boolean> {
  return api().permissions.contains({ origins: [...ALL_SITES] });
}

/**
 * Ask for every site at once — the escape hatch for people who do not want to
 * be asked again.
 *
 * WHY OFFER THIS AT ALL, when asking per origin is the thing that makes the
 * install prompt clean. Because the per-origin flow is right for someone
 * answering a question about the page in front of them, and wrong for someone
 * who has just pointed the agent at a research task across a dozen domains they
 * cannot name in advance. Refusing to offer it does not make that person safer;
 * it makes them close the panel.
 *
 * IT IS STILL ONE GESTURE AND ONE CHROME PROMPT, and Chrome's own dialog is
 * what asks. Nothing here can grant it quietly: like `requestHostAccess`, this
 * MUST be called synchronously from a click, so the agent loop cannot reach it.
 *
 * WHAT IT DOES NOT DO is grant every site in our own record. `canActOn` is a
 * conjunction, and this only satisfies the Chrome half — the per-site allow-list
 * still applies, so the agent still asks before touching a NEW site and the
 * user's Sites list still means what it says. That is deliberate: "stop asking
 * Chrome" and "let the agent go anywhere" are different requests, and only the
 * first one is being made here.
 */
export async function requestAllSites(): Promise<boolean> {
  try {
    return await api().permissions.request({ origins: [...ALL_SITES] });
  } catch {
    // Thrown rather than resolved false when called outside a gesture. That is
    // a programming error, not a user decision, so it must not be reported as
    // a decline.
    return false;
  }
}

/**
 * Hand back blanket access, leaving individual sites alone.
 *
 * `permissions.remove` on the broad patterns does NOT remove narrower grants
 * the user made one at a time — those are separate entries — so this is a
 * genuine step down rather than a reset. Nothing is removed from our own
 * record, which is what makes it reversible without the user losing the list
 * they built.
 */
export async function revokeAllSites(): Promise<boolean> {
  try {
    return await api().permissions.remove({ origins: [...ALL_SITES] });
  } catch {
    return false;
  }
}
