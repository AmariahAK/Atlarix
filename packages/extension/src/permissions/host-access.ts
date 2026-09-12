/**
 * Host access — the half of a site grant that Chrome itself enforces.
 *
 * `site-grants.ts` records the user's INTENT, and its own docblock is honest
 * about the limit: `chrome.storage` is a LevelDB file any local process running
 * as the user can rewrite, so a record there is not a boundary. This module is
 * the boundary. Every grant is backed by a real `optional_host_permissions`
 * request, so an origin the user has not approved is one the browser will not
 * let us script — whatever the stored record says.
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
  // file:// or about: page. The manifest's optional_host_permissions says the
  // same thing, so this is the code and the manifest agreeing rather than two
  // separate rules.
  if (!pattern) return { ok: false, reason: "unsupported-scheme" };

  const granted = await api().permissions.request({ origins: [pattern] });
  if (!granted) return { ok: false, reason: "declined" };

  await grantSite(url);
  return { ok: true };
}

/** Drop both halves. Leaving either behind is a lie about the other. */
export async function revokeHostAccess(url: string): Promise<void> {
  const pattern = matchPatternFor(url);
  if (pattern) {
    await api().permissions.remove({ origins: [pattern] });
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
