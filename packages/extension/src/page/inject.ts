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
 * Run one kernel request against `tabId`.
 *
 * Callers must have confirmed host access first (`permissions/host-access.ts`).
 * This deliberately does NOT request it: `permissions.request()` needs a user
 * gesture, and a transport that tried to acquire access would be the agent
 * widening its own reach.
 */
export async function runInPage<T>(
  tabId: number,
  req: PageRequest,
): Promise<T> {
  let results;
  try {
    results = await api().scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: atlarixPageKernel,
      args: [req],
    });
  } catch (err) {
    // The common causes are all the same shape to the caller: no host
    // permission for this origin, a restricted page (chrome://, the Web Store),
    // or a tab that navigated away mid-call. Chrome's own message names which.
    throw new PageAccessError(
      `Could not read the page: ${err instanceof Error ? err.message : String(err)}`,
    );
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
