/**
 * Running the shared page kernel in one of the user's real tabs.
 *
 * This is the whole "one contract, two backends" claim made concrete, and it is
 * eleven lines because the design work happened in `page-scripts`: the desktop
 * splices `atlarixPageKernel.toString()` into `executeJavaScript`, and this
 * hands the same function to `executeScript`. There is one implementation, so
 * the shapes cannot drift.
 *
 * THREE ARGUMENTS BELOW ARE NOT PREFERENCES.
 *
 * `func` + `args`, never a string. MV3 removed `code:`; `executeScript` accepts
 * `func` or `files` and nothing else, the extension CSP bars `unsafe-eval`, and
 * in `world: "MAIN"` an `eval()` runs under the PAGE's CSP, which GitHub,
 * Google and most banks block. There is no route that executes a string here.
 *
 * `world: "MAIN"`. The ref registry is a WeakMap on `window`. An isolated world
 * is a different realm with a different `window`, so every read would mint
 * fresh refs and every later action would fail to resolve one — silently, since
 * a missing ref looks exactly like an element that has gone away.
 *
 * `allFrames` stays false. `executeScript` returns one result PER FRAME, and a
 * ref minted in frame N resolves only in frame N. The desktop's
 * `executeJavaScript` has no such ambiguity, so allowing it here would be the
 * one place the two backends genuinely disagreed.
 */

import type { PageRequest } from "@/lib/browser/page-scripts";
import { atlarixPageKernel } from "@/lib/browser/page-scripts";
import { api } from "../shared/browser-api";

/** A tab the agent may not touch, and why — in words a model can act on. */
export class PageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageAccessError";
  }
}

/**
 * Chrome refusing because the USER withheld this site — the one failure here
 * with a fix, and the one nothing else can detect.
 *
 * DECLARING A HOST PERMISSION IS NOT THE SAME AS HOLDING IT. Chrome lets anyone
 * narrow an extension from `chrome://extensions → Site access` to "On click" or
 * a chosen list, and a withheld origin makes `executeScript` throw while our own
 * allow-list still says yes. There is no event and no flag: the refusal IS the
 * signal. So a raw pass-through here reads to the model as a broken page, and it
 * retries, and it keeps failing, and the user is never told the one thing that
 * would fix it.
 *
 * Matched on Chrome's own wording rather than on an error type, because there
 * is no type to match — and deliberately loosely, since the exact sentence has
 * changed between Chrome versions while the two distinctive halves have not.
 *
 * Returns null for every other cause, so the caller keeps Chrome's own text.
 */
function withheldHostHelp(message: string): string | null {
  const m = message.toLowerCase();
  const refused =
    m.includes("cannot access contents of") ||
    m.includes("cannot access contents of the page") ||
    (m.includes("extension manifest must request permission") &&
      m.includes("host"));
  if (!refused) return null;
  return (
    "Chrome is blocking Atlarix from this site. This is not the site grant — " +
    "it is the browser's own Site access setting, which only the user can " +
    "change: chrome://extensions → Atlarix → Site access → On all sites. " +
    "Nothing was read. Tell the user that, and do not retry until they say " +
    "they have changed it."
  );
}

/**
 * Run one kernel request against `tabId`.
 *
 * Callers must have confirmed the site is allowed first
 * (`permissions/site-grants.ts`). This deliberately does NOT grant it: a
 * transport that quietly widened its own reach would make the allow-list
 * decorative.
 */
export async function runInPage<T>(
  tabId: number,
  req: PageRequest,
): Promise<T> {
  return runPageFunction<T, [PageRequest]>(tabId, atlarixPageKernel, [req]);
}

/**
 * Run any PORTABLE page function (kernel rules: no imports, no module scope)
 * in the tab's main world. `runInPage` is this with the kernel; the visual and
 * design reports (`page-scripts/visual.ts`) are the other callers. An async
 * function is fine — Chrome awaits the promise and returns its value.
 */
export async function runPageFunction<T, A extends unknown[]>(
  tabId: number,
  func: (...args: A) => unknown,
  args: A,
): Promise<T> {
  let results;
  try {
    results = await api().scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: func as (...a: unknown[]) => unknown,
      args: args as unknown[],
    });
  } catch (err) {
    // The common causes are all the same shape to the caller: a restricted page
    // (chrome://, the Web Store), a tab that navigated away mid-call, or the
    // user having WITHHELD this site from the extension. Chrome's own message
    // names which, and the last one gets translated because it is the only one
    // with a fix the user can carry out.
    const raw = err instanceof Error ? err.message : String(err);
    throw new PageAccessError(withheldHostHelp(raw) ?? `Could not read the page: ${raw}`);
  }

  // One frame requested, so one result. An empty array means the frame went
  // away between the permission check and the injection — a real race on a page
  // that redirects, and reporting it beats returning undefined.
  const hit = results[0];
  if (!hit) {
    throw new PageAccessError(
      "The page went away before it could be read (it may have navigated).",
    );
  }
  return hit.result as T;
}

/**
 * Inject a file PACKAGED with the extension (e.g. `vendor/axe.min.js`) into the
 * tab's main world. `files` is the only other thing `executeScript` accepts, and
 * a packaged file runs under the extension's review, not as a string.
 * Best-effort: returns false rather than throwing, because every caller has a
 * useful answer without it.
 */
export async function injectPackagedFile(
  tabId: number,
  file: string,
): Promise<boolean> {
  try {
    await api().scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: [file],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `ref` still point at an element in this tab?
 *
 * PHASE 1'S STATED GOAL: prove a ref minted by a read resolves on a LATER,
 * SEPARATE call. Two `executeScript` calls share nothing but the page's own
 * `window`, so this passing is the evidence that the registry survives the
 * transport — the property every later action depends on.
 *
 * A small dedicated `func` rather than a kernel op, deliberately. Resolving an
 * element is the ACTION path, which is still strings on the desktop and stays
 * that way until Phase 3; adding a kernel op now would put the two backends out
 * of step for the sake of a check. This is a probe, not part of the contract.
 */
export async function refResolves(
  tabId: number,
  ref: string,
): Promise<boolean> {
  const [hit] = await api().scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (value: string) =>
      // CSS.escape for the same reason the desktop uses it: a ref is a value we
      // minted, but the selector path must not become an injection surface if
      // that ever stops being true.
      Boolean(
        document.querySelector(
          '[data-atlarix-ref="' + CSS.escape(value) + '"]',
        ),
      ),
    args: [ref],
  });
  return Boolean(hit?.result);
}

/** The active tab in the focused window, or null if there is none. */
export async function activeTab(): Promise<{ id: number; url: string } | null> {
  const [tab] = await api().tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) return null;
  return { id: tab.id, url: tab.url };
}
