/**
 * Per-site grants: the one gate the extension asks, and where it is kept.
 *
 * The user is asked once the first time the agent touches a domain, and never
 * again for that domain. Both Claude in Chrome and OpenAI's extension arrived at
 * this independently, which is about as good a signal as this kind of design
 * gets. A grant does NOT unlock the always-ask set — see `always-ask.ts`.
 *
 * WHY `storage.sync` AND NOT SUPABASE. A grant is a statement about THIS browser
 * profile: "in this browser, the agent may act on app.example.com". It rides the
 * profile the way a bookmark does. Memory and sessions go server-side because the
 * ACCOUNT is portable; a grant is not the account's, and pushing one to every
 * device the user signs into would silently widen the agent's reach on machines
 * they never approved it on.
 *
 * WHAT A GRANT IS NOT. `chrome.storage` is a LevelDB file on disk that any local
 * process running as the user can rewrite — a known, publicly reported hole
 * against a competitor's identical design. So a grant is a record of the USER'S
 * INTENT, not a security boundary against local code. Anything that must hold
 * against a local attacker cannot be built on it.
 *
 * THE SUBTLE PART IS `originOf`, NOT THE STORAGE. Every interesting failure here
 * is a string that looks like a hostname and is not one — see its comment.
 */

import { api } from "../shared/browser-api";

/** Where grants live inside `storage.sync`. */
const STORAGE_KEY = "atlarix.siteGrants.v1";

export interface SiteGrant {
  /** Serialized origin: scheme + host + non-default port. The key. */
  origin: string;
  /** Epoch ms the user granted it. Shown in settings so a grant can be aged out. */
  grantedAt: number;
}

type GrantMap = Record<string, SiteGrant>;

/**
 * The origin a URL belongs to, or null if it is not a page we can grant.
 *
 * Parsed with the URL API rather than matched with a regex, deliberately. Every
 * classic failure in this function is a string that reads like a hostname to a
 * pattern and resolves somewhere else entirely:
 *
 *   - `https://evil.com/?x=app.example.com`  — the real host is evil.com.
 *   - `https://app.example.com.evil.com`     — a suffix match grants evil.com.
 *   - `https://user:pw@evil.com`             — the part before `@` is not a host.
 *   - `https://аpp.example.com`              — Cyrillic `а`. `URL` renders it as
 *                                              punycode (`xn--`), so the grant is
 *                                              stored and compared as a DIFFERENT
 *                                              origin from the Latin spelling,
 *                                              which is exactly right.
 *
 * Ports and schemes are part of the identity: `https://x.test` and
 * `http://x.test` are different origins, and so are `:8080` and the default.
 * `URL.origin` normalises the default port away on its own.
 *
 * Only http(s) can be granted. A `file://`, `chrome://` or `javascript:` URL
 * returns null and therefore can never hold a grant — the settings pages among
 * them are separately in the always-ask set.
 */
export function originOf(url: string | undefined | null): string | null {
  if (typeof url !== "string" || url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // A URL with no host ("https:///path") parses but grants nothing meaningful.
  if (!parsed.hostname) return null;
  // `URL.origin` is already scheme + host + non-default port, and drops any
  // userinfo, path, query and fragment. It is the whole normalisation.
  const origin = parsed.origin;
  return origin === "null" ? null : origin;
}

/** True when two URLs are the same grantable origin. */
export function sameOrigin(a: string, b: string): boolean {
  const oa = originOf(a);
  const ob = originOf(b);
  return oa !== null && oa === ob;
}

async function readAll(): Promise<GrantMap> {
  const raw =
    await api().storage.sync.get<Record<string, unknown>>(STORAGE_KEY);
  const value = raw?.[STORAGE_KEY];
  if (!value || typeof value !== "object") return {};
  return value as GrantMap;
}

async function writeAll(map: GrantMap): Promise<void> {
  await api().storage.sync.set({ [STORAGE_KEY]: map });
}

/**
 * Has the user granted this URL's origin?
 *
 * An ungrantable URL is always false, never a throw: this sits on the hot path
 * of every action, and the caller's next move is to ask the user, which is the
 * correct outcome for a URL we cannot name.
 */
export async function isGranted(url: string): Promise<boolean> {
  const origin = originOf(url);
  if (!origin) return false;
  const all = await readAll();
  return Object.prototype.hasOwnProperty.call(all, origin);
}

/** Record the user's yes. Re-granting an existing origin refreshes its date. */
export async function grantSite(url: string): Promise<SiteGrant | null> {
  const origin = originOf(url);
  if (!origin) return null;
  const all = await readAll();
  const grant: SiteGrant = { origin, grantedAt: Date.now() };
  all[origin] = grant;
  await writeAll(all);
  return grant;
}

/** Revoke one origin. Returns whether anything was there to revoke. */
export async function revokeSite(url: string): Promise<boolean> {
  const origin = originOf(url) ?? url;
  const all = await readAll();
  if (!Object.prototype.hasOwnProperty.call(all, origin)) return false;
  delete all[origin];
  await writeAll(all);
  return true;
}

/** Every grant, newest first — the settings list. */
export async function listGrants(): Promise<SiteGrant[]> {
  const all = await readAll();
  return Object.values(all).sort((a, b) => b.grantedAt - a.grantedAt);
}

/** Revoke everything. The "start over" button. */
export async function revokeAll(): Promise<void> {
  await api().storage.sync.remove(STORAGE_KEY);
}
