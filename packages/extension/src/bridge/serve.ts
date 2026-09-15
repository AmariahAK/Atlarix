/**
 * Answering the desktop app. One switch, no agent, no model, no approvals.
 *
 * ══ WHAT THIS FILE MUST NOT IMPORT, AND WHY IT IS A TEST ══
 *
 * Not `agent/loop.ts`, not `tools/dispatch.ts`, not `core/client.ts`, and
 * nothing under `panel/`. `dispatch.ts` is the tempting one — it already knows
 * how to click a ref — and importing it would drag the model client and the
 * approval plumbing into the service worker, where they would run INSIDE a
 * bridged request. The user would be asked twice for one action: once by the
 * desktop, which already asked, and once by a panel that may not even be open.
 *
 * The rule is enforced by `bridge-imports.test.ts` rather than by this comment,
 * because the import that breaks it will look entirely reasonable.
 *
 * ══ WHO DECIDES WHETHER AN ACTION IS ALLOWED ══
 *
 * The desktop asked, so the DESKTOP owns the "should this happen" question —
 * its own approval flow ran before the request was sent, and asking again in
 * the browser would be the double prompt above.
 *
 * What is NOT delegated is the SITE GRANT. `canActOn` still gates every page
 * action here, because it is a promise the extension made to the user in its
 * own UI and on the Web Store listing: Atlarix works on the sites you allow and
 * only those. A desktop request is not a way around that, and the refusal says
 * how to grant the site rather than merely failing.
 *
 * ══ THE SERVICE WORKER IS THE RIGHT HOME, WHICH IS THE OPPOSITE OF THE LOOP ══
 *
 * `agent/loop.ts` lives in the panel because a >30s streaming fetch kills the
 * worker. The bridge is the other case entirely: event-driven, millisecond
 * requests, and it must answer whether or not a panel happens to be open. A
 * bridge in the panel would mean "the desktop can drive Chrome only while you
 * are looking at it", which is not a product.
 */

import {
  MAX_ELEMENTS,
  MAX_ELEMENTS_ALL,
  MAX_FIND_MATCHES,
  type A11yFindResult,
  type A11ySnapshot,
  type PageActionResult,
} from "@/lib/browser/page-scripts";
import { formatFind, formatSnapshot } from "@/lib/browser/a11y-format";
import { api } from "../shared/browser-api";
import { activeTab, runInPage } from "../page/inject";
import { canActOn } from "../permissions/host-access";
import { adoptTab, isAgentTab } from "../tabs/group";

export interface BridgeRequest {
  id: string;
  op: string;
  args?: Record<string, unknown>;
}

export type BridgeReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The tab a request means: an explicit id, else whatever the user is on. */
async function targetTab(args: Record<string, unknown>): Promise<number> {
  const explicit = num(args.tab_id);
  if (explicit !== null) return explicit;
  const tab = await activeTab();
  if (!tab?.id) throw new Error("there is no active tab in this browser window");
  return tab.id;
}

/**
 * The site-grant gate, and the only place in this file that can refuse.
 *
 * The message names the panel because that is the ONLY place a grant can be
 * made: `chrome.permissions.request()` needs a user gesture, which neither the
 * desktop nor a service worker can supply. Saying "permission denied" without
 * that sentence would leave the desktop with nothing to tell the user.
 */
async function requireGrant(tabId: number): Promise<string> {
  const tab = await api().tabs.get(tabId);
  const url = tab?.url ?? "";
  if (!url) throw new Error(`tab ${tabId} has no URL — it may have been closed`);
  if (!(await canActOn(url))) {
    throw new Error(
      `Atlarix has not been allowed to work on ${originOf(url)}. Open the ` +
        `Atlarix side panel in the browser and allow that site — granting needs ` +
        `a click in the browser and cannot be done from the desktop app.`,
    );
  }
  return url;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Ops the desktop may ask for.
 *
 * DELIBERATELY SHORTER THAN THE PANEL'S TOOL LIST. Everything here maps onto a
 * kernel op or a `chrome.tabs` call that exists. Anything whose data comes from
 * a hook the desktop's own BrowserView installs — console, network, visual
 * diffing — is absent rather than stubbed, because an empty console read is
 * indistinguishable from a clean page and is the worst possible lie.
 */
export async function serveBridgeRequest(
  request: BridgeRequest,
): Promise<BridgeReply> {
  const args = request.args ?? {};
  try {
    const result = await run(request.op, args);
    return { id: request.id, ok: true, result };
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function run(op: string, args: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    // The handshake probe. Touches nothing, so a desktop that can round-trip
    // this knows the whole chain works before any permission is involved.
    case "ping":
      return { pong: true, at: Date.now() };

    case "list_tabs": {
      const tabs = await api().tabs.query({});
      return Promise.all(
        tabs.map(async (t) => ({
          id: t.id,
          title: t.title ?? "",
          url: t.url ?? "",
          active: Boolean(t.active),
          agent: t.id !== undefined && (await isAgentTab(t.id)),
          granted: t.url ? await canActOn(t.url) : false,
        })),
      );
    }

    case "get_url": {
      const tabId = await targetTab(args);
      const tab = await api().tabs.get(tabId);
      return { tabId, url: tab?.url ?? "", title: tab?.title ?? "" };
    }

    case "read_page": {
      const tabId = await targetTab(args);
      const url = await requireGrant(tabId);
      const all = str(args.filter) === "all";
      const snapshot = await runInPage<A11ySnapshot>(tabId, {
        op: "snapshot",
        filter: all ? "all" : "interactive",
        max: all ? MAX_ELEMENTS_ALL : MAX_ELEMENTS,
      });
      return { tabId, url, text: formatSnapshot(snapshot) };
    }

    case "find_on_page": {
      const tabId = await targetTab(args);
      const url = await requireGrant(tabId);
      const found = await runInPage<A11yFindResult>(tabId, {
        op: "find",
        query: str(args.query),
        max: MAX_FIND_MATCHES,
      });
      return { tabId, url, text: formatFind(found) };
    }

    case "click": {
      const tabId = await targetTab(args);
      await requireGrant(tabId);
      const done = await runInPage<PageActionResult>(tabId, {
        op: "click",
        ref: str(args.ref) || undefined,
        selector: str(args.selector) || undefined,
      });
      return done;
    }

    case "fill": {
      const tabId = await targetTab(args);
      await requireGrant(tabId);
      const done = await runInPage<PageActionResult>(tabId, {
        op: "fill",
        ref: str(args.ref) || undefined,
        selector: str(args.selector) || undefined,
        value: typeof args.value === "boolean" ? args.value : str(args.value),
      });
      return done;
    }

    case "scroll": {
      const tabId = await targetTab(args);
      await requireGrant(tabId);
      return runInPage<PageActionResult>(tabId, {
        op: "scroll",
        ref: str(args.ref) || undefined,
        to: str(args.to) === "top" || str(args.to) === "bottom" ? (str(args.to) as "top" | "bottom") : undefined,
        by: num(args.by) ?? undefined,
      } as never);
    }

    case "open_tab": {
      const url = str(args.url);
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`open_tab needs an http(s) URL, got "${url}"`);
      }
      const tab = await api().tabs.create({ url, active: false });
      // INTO THE AGENT'S GROUP, exactly as the panel does it. A tab Atlarix
      // opened must be visibly Atlarix's whichever surface asked for it, or the
      // group stops meaning "what it touched" and the user loses their stop
      // gesture.
      if (tab?.id !== undefined && tab.windowId !== undefined) {
        await adoptTab(tab.id, tab.windowId).catch(() => {});
      }
      return { tabId: tab?.id ?? null, url };
    }

    case "close_tab": {
      const tabId = num(args.tab_id);
      if (tabId === null) throw new Error("close_tab needs tab_id");
      // ONLY TABS ATLARIX OPENED. The panel enforces the same rule and it is
      // not negotiable across surfaces: the user's own tabs are not ours to
      // close, and a desktop request is not a reason to change that.
      if (!(await isAgentTab(tabId))) {
        throw new Error(
          `tab ${tabId} was not opened by Atlarix, so it will not be closed`,
        );
      }
      await api().tabs.remove(tabId);
      return { closed: tabId };
    }

    default:
      throw new Error(
        `the browser extension has no bridged op "${op}". This build may be ` +
          `older than the desktop app asking.`,
      );
  }
}
