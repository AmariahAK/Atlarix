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

/*
 * NO PRUNE. A grant used to be deleted whenever Chrome stopped allowing its
 * site. With http(s) host access REQUIRED, that only happens when the user
 * narrows Site access in chrome://extensions ("On click"), which withholds
 * every site at once: one turn in that mode erased every grant (QA A3). The
 * grant is the user's intent and Chrome's setting is the boundary; `canActOn`
 * already needs both, and dispatch says "Chrome is blocking" for the gap.
 */

/**
 * THERE IS NO BLANKET "EVERY SITE" PATH HERE ANY MORE.
 *
 * `ALL_SITES`, `hasAllSites()`, `requestAllSites()` and `revokeAllSites()` were
 * removed on 2026-09-18. They were written when host access was OPTIONAL, where
 * `permissions.request()` on the broad patterns did real work. Host access
 * became a REQUIRED manifest permission on 2026-09-17, after which Chrome
 * already held those patterns at install: `request()` resolved true instantly
 * with no dialog, `contains()` answered true for every http(s) origin, and
 * `remove()` could not take a required permission back. All four functions
 * became no-ops, and the panel button on top of them reported success while
 * granting exactly one origin.
 *
 * `hasAllSites` and `revokeAllSites` never had a production caller at all — only
 * the test file — which is how the whole group stayed green while meaning
 * nothing. `canActOn` is now effectively the per-site allow-list alone, and that
 * is the honest description of the gate.
 */
