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
 * NOTHING IS GATED HERE AT ALL, as of 2026-09-17. Host access is a REQUIRED
 * manifest permission, so Chrome grants it at install and a desktop-driven
 * request just runs. The extension's own per-site list is not consulted on this
 * path either: the user approved the action in the app, and asking again in a
 * window they are not looking at was the same decision relocated to where they
 * could not answer it. That was not a theory — it blocked three rounds of live
 * testing, and each "fix" was another layer in front of a door that should have
 * been open.
 *
 * The panel's agent is unchanged and still asks per site. That asymmetry is the
 * safety story now, and the Web Store copy states it: broad access exists for
 * the desktop integration, while the in-browser agent keeps a self-imposed
 * limit. If a user narrows Site access from chrome://extensions, Chrome refuses
 * the injection and its own error surfaces.
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
  PAGE_TEXT_MAX_CHARS,
  type A11yFindResult,
  type A11ySnapshot,
  type PageActionResult,
  type PageTextResult,
} from "@/lib/browser/page-scripts";
import { formatFind, formatSnapshot } from "@/lib/browser/a11y-format";
import { api } from "../shared/browser-api";
import { activeTab, runInPage } from "../page/inject";
import { adoptTab, isAgentTab, setGroupTitle } from "../tabs/group";
import {
  armNetwork,
  beginCapture,
  endCapture,
  readConsole,
  readNetwork,
} from "../page/cdp-capture";
import {
  attach,
  isNamedKey,
  movePointer,
  namedKeys,
  pressKey,
} from "../page/trusted-input";

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

/**
 * The tab a request means.
 *
 * ══ THE AGENT'S OWN GROUP COMES FIRST, AND THAT IS THE WHOLE POINT ══
 *
 * This used to fall straight through to `activeTab()` — whatever the user was
 * looking at THIS INSTANT. So a turn that opened a page, then read "the page",
 * read whatever tab the user had switched to in the meantime: the wrong answer,
 * derived from the user's own browsing, and a click could land in their mail or
 * their bank. It also made the two halves of one turn non-deterministic, because
 * the target changed whenever the user did.
 *
 * Preferring the agent's group fixes both. The agent works in its own emerald
 * group; the user keeps browsing in theirs; neither is disturbed and nothing
 * takes focus (`open_tab` passes `active: false` and nothing here activates a
 * tab). The user's stop gesture stays exactly what it was — close the group.
 *
 * THE USER'S CURRENT TAB IS STILL REACHABLE, deliberately and only on purpose:
 * pass its `tab_id` from `list_tabs`, which flags every tab with `active` and
 * `agent` so the caller can tell them apart. "Read the page I am on" is a real
 * request; it just has to be asked for rather than assumed.
 *
 * The fallback to the active tab survives for the first read of a session, when
 * the agent has no tabs of its own yet and "the page" can only mean the user's.
 */
async function targetTab(args: Record<string, unknown>): Promise<number> {
  const explicit = num(args.tab_id);
  if (explicit !== null) return explicit;

  const all = await api().tabs.query({});
  const mine: { id: number; lastAccessed: number }[] = [];
  for (const t of all) {
    if (t.id === undefined) continue;
    if (await isAgentTab(t.id)) {
      mine.push({
        id: t.id,
        lastAccessed:
          (t as { lastAccessed?: number }).lastAccessed ?? 0,
      });
    }
  }
  if (mine.length > 0) {
    // Most recently touched of the agent's own tabs — the closest available
    // proxy for "the one this turn is working in" when several are open.
    return mine.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a)).id;
  }

  const tab = await activeTab();
  if (!tab?.id) throw new Error("there is no active tab in this browser window");
  return tab.id;
}

/**
 * The tab's URL, for the result. THERE IS NO PERMISSION CHECK HERE, AND THAT IS
 * THE DESIGN.
 *
 * This used to be `requireGrant`, and it refused a page unless the browser had
 * been told to allow that origin. For a request the DESKTOP made it was the
 * wrong question in the wrong window: the user approved the action in the app,
 * and the refusal arrived somewhere they could not answer it. Three rounds of
 * live testing died there, and every fix I reached for — a clearer refusal, a
 * badge, a panel banner — was more machinery in front of a door that should not
 * have been shut.
 *
 * Host access is a REQUIRED manifest permission now, so Chrome grants it at
 * install and these ops simply work. If a user narrows Site access from
 * chrome://extensions, `chrome.scripting` refuses the injection and CHROME'S
 * OWN error surfaces — which is the honest report, and needs no wording from
 * us. The panel's agent is unchanged: it still asks per site, because it
 * decides for itself what to touch.
 */
async function tabUrl(tabId: number): Promise<string> {
  const tab = await api().tabs.get(tabId);
  const url = tab?.url ?? "";
  if (!url) throw new Error(`tab ${tabId} has no URL — it may have been closed`);
  return url;
}

/**
 * SAY ON THE PAGE THAT ATLARIX IS DRIVING IT.
 *
 * The panel's own agent has done this since it shipped (`tools/dispatch.ts`
 * calls the same op); the BRIDGE never did, so a desktop-driven action was
 * completely invisible in the user's own browser. That is the one place an
 * invisible agent is least acceptable: it is their window, their tabs, their
 * logged-in sessions, and the tab group alone does not say "something is
 * happening right now".
 *
 * Best-effort throughout. Failing to DECORATE a page must never fail the action
 * that was about to happen on it.
 */
const clearTimers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * How long the frame stays up after the last op on a tab.
 *
 * The bridge has no notion of a turn ending — the desktop does, but it does not
 * tell us — so the indicator is held open by activity and released by silence.
 * If the service worker is killed first the frame simply stays until the page
 * navigates, which errs toward VISIBLE, and that is the correct direction to be
 * wrong in for a thing whose whole job is disclosure.
 */
const OVERLAY_LINGER_MS = 8_000;

async function markDriven(tabId: number): Promise<void> {
  try {
    await runInPage(tabId, { op: "overlay", state: "on" });
  } catch {
    /* a restricted or vanished page; the action itself will report properly */
  }
  try {
    const tab = await api().tabs.get(tabId);
    if (tab?.windowId !== undefined) {
      await setGroupTitle(tab.windowId, "Atlarix · working");
    }
  } catch {
    /* no group yet, or the tab went away */
  }

  const existing = clearTimers.get(tabId);
  if (existing) clearTimeout(existing);
  clearTimers.set(
    tabId,
    setTimeout(() => {
      clearTimers.delete(tabId);
      void releaseTab(tabId);
    }, OVERLAY_LINGER_MS),
  );
}

async function releaseTab(tabId: number): Promise<void> {
  try {
    await runInPage(tabId, { op: "overlay", state: "off" });
  } catch {
    /* closed, navigated away, or never granted — nothing to take down */
  }
  try {
    const tab = await api().tabs.get(tabId);
    if (tab?.windowId !== undefined) await setGroupTitle(tab.windowId, "Atlarix");
  } catch {
    /* gone */
  }
}

/**
 * The gate for anything that needs a REAL keystroke or pointer move.
 *
 * Both go through `chrome.debugger`, which banners the tab and evicts DevTools
 * from it. That is not ours to do to a tab someone is reading, so it is limited
 * to tabs Atlarix opened — the same rule the panel enforces, and the reason the
 * banner the user sees is honest rather than alarming. The refusal names the
 * two ways forward instead of merely declining.
 */
async function requireOwnTabForInput(tabId: number, what: string): Promise<void> {
  if (await isAgentTab(tabId)) return;
  throw new Error(
    `${what} needs a real keystroke or pointer move, which means attaching a ` +
      `debugger to the tab — that shows a banner and takes DevTools away from ` +
      `whoever is using it. Tab ${tabId} is the user's own, so nothing was ` +
      `done. Either click the control you wanted to trigger, or open the page ` +
      `yourself (tabs operation:"create") and work in that copy.`,
  );
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
      const url = await tabUrl(tabId);
      await markDriven(tabId);
      const all = str(args.filter) === "all";
      const snapshot = await runInPage<A11ySnapshot>(tabId, {
        op: "snapshot",
        filter: all ? "all" : "interactive",
        max: all ? MAX_ELEMENTS_ALL : MAX_ELEMENTS,
      });
      return { tabId, url, text: formatSnapshot(snapshot) };
    }

    // The raw visible text, for browser_inspect(mode:"text"). Distinct from
    // read_page, which returns a formatted a11y tree: a caller after prose gets
    // nothing usable from a list of controls.
    case "text": {
      const tabId = await targetTab(args);
      const url = await tabUrl(tabId);
      await markDriven(tabId);
      const res = await runInPage<PageTextResult>(tabId, {
        op: "text",
        selector: str(args.selector) || undefined,
        max: PAGE_TEXT_MAX_CHARS,
      });
      if (!res.ok) throw new Error(res.error ?? "the page text could not be read");
      return { tabId, url, text: res.text, clipped: res.clipped };
    }

    case "find_on_page": {
      const tabId = await targetTab(args);
      const url = await tabUrl(tabId);
      await markDriven(tabId);
      const found = await runInPage<A11yFindResult>(tabId, {
        op: "find",
        query: str(args.query),
        max: MAX_FIND_MATCHES,
      });
      return { tabId, url, text: formatFind(found) };
    }

    /**
     * RESOLVE FIRST, AND NOT ONLY TO FIND THE ELEMENT.
     *
     * `resolve` is what draws the pointer — the kernel's `click` op draws
     * nothing. The desktop has always done this (`clickScript` resolves with
     * `cursor: "click"` before it clicks); the bridge went straight to `click`,
     * so an agent driving the user's own browser moved things with no pointer
     * anywhere on screen. Resolving also scrolls the element into view, which
     * `click` alone does not.
     */
    case "click": {
      const tabId = await targetTab(args);
      await markDriven(tabId);
      const ref = str(args.ref) || undefined;
      const selector = str(args.selector) || undefined;
      await runInPage<PageActionResult>(tabId, {
        op: "resolve",
        ref,
        selector,
        cursor: "click",
      }).catch(() => undefined);
      return runInPage<PageActionResult>(tabId, { op: "click", ref, selector });
    }

    /** Same as `click`: resolve draws the pointer and scrolls into view. */
    case "fill": {
      const tabId = await targetTab(args);
      await markDriven(tabId);
      const ref = str(args.ref) || undefined;
      const selector = str(args.selector) || undefined;
      await runInPage<PageActionResult>(tabId, {
        op: "resolve",
        ref,
        selector,
        cursor: "type",
      }).catch(() => undefined);
      return runInPage<PageActionResult>(tabId, {
        op: "fill",
        ref,
        selector,
        value: typeof args.value === "boolean" ? args.value : str(args.value),
      });
    }

    /**
     * THIS SENT ARGUMENTS THE KERNEL DOES NOT READ, and an `as never` cast hid
     * it. The kernel's scroll op takes `direction` + `amount`; this passed
     * `ref`, `to` and `by`, so `req.direction` was always undefined and every
     * bridged scroll fell through to "down one viewport" — never up, never to
     * top or bottom, and `by` ignored. A silent wrong answer, not an error.
     *
     * A `ref` is a different operation and routes to `resolve`, which scrolls
     * the element into view as part of its contract (its rect is in viewport
     * coordinates, so it has no choice).
     */
    case "scroll": {
      const tabId = await targetTab(args);
      const ref = str(args.ref);
      if (ref) {
        await markDriven(tabId);
        return runInPage<PageActionResult>(tabId, { op: "resolve", ref });
      }
      const direction = str(args.direction);
      if (direction === "left" || direction === "right") {
        throw new Error(
          `scrolling ${direction} is not available over the browser extension — ` +
            `the shared page kernel scrolls vertically only. Retry with ` +
            `target:"app" if you need horizontal scrolling.`,
        );
      }
      if (
        direction !== "up" &&
        direction !== "down" &&
        direction !== "top" &&
        direction !== "bottom"
      ) {
        throw new Error(
          `scroll needs direction "up", "down", "top" or "bottom", got ` +
            `"${direction}"`,
        );
      }
      await markDriven(tabId);
      return runInPage<PageActionResult>(tabId, {
        op: "scroll",
        direction,
        amount: num(args.amount) ?? undefined,
      });
    }

    /**
     * A REAL keystroke, not a synthetic event.
     *
     * The extension has had this since it shipped (`page/trusted-input.ts`,
     * over `chrome.debugger`) — the bridge simply never exposed it, so the
     * desktop refused `action:"key"` outright while the capability sat one
     * import away. Enter is the point of it: a synthetic event does not submit
     * a form, and a page that validates on keydown never sees a value that was
     * pasted in.
     */
    case "key": {
      const name = str(args.key) || str(args.text);
      if (!isNamedKey(name)) {
        throw new Error(
          `Unknown key "${name}". This build can press: ${namedKeys().join(", ")}.`,
        );
      }
      const tabId = await targetTab(args);
      await requireOwnTabForInput(tabId, `Pressing ${name}`);
      await markDriven(tabId);
      await attach(tabId);
      await pressKey(tabId, name);
      return {
        tabId,
        pressed: name,
        note:
          name === "Enter"
            ? "This may have submitted a form and navigated. Read the page to see what it did."
            : "Nothing is assumed to have changed. Read the page to see what it did.",
      };
    }

    /** Opens :hover menus and tooltips. Same debugger gate as `key`. */
    case "hover": {
      const tabId = await targetTab(args);
      await requireOwnTabForInput(tabId, "Hovering");
      await markDriven(tabId);
      // Resolve FIRST: a pointer event takes coordinates, not a node, and the
      // rect is only meaningful once the element has been scrolled into view.
      const resolved = await runInPage<PageActionResult>(tabId, {
        op: "resolve",
        ref: str(args.ref) || undefined,
        selector: str(args.selector) || undefined,
        cursor: "hover",
      });
      if (!resolved.ok || !resolved.rect) {
        throw new Error(resolved.error ?? "Could not find that element to hover.");
      }
      await attach(tabId);
      await movePointer(tabId, resolved.rect.x, resolved.rect.y);
      return { tabId, hovered: resolved.label ?? resolved.tag ?? "element" };
    }

    /**
     * The page's console, from the CDP buffer opened when Atlarix made the tab.
     *
     * `unavailable` is carried separately from an empty list and that IS the
     * feature: "the page logged nothing" and "we could not watch" are different
     * answers, and collapsing them into `[]` is the lie this op was written to
     * stop telling.
     */
    case "console": {
      const tabId = await targetTab(args);
      const level = str(args.level);
      return {
        tabId,
        ...readConsole(
          tabId,
          level === "errors" || level === "warnings" ? level : "all",
        ),
      };
    }

    /** The requests the page made. Same empty-vs-unavailable rule as `console`. */
    case "network": {
      const tabId = await targetTab(args);
      // Arm on demand too: a tab captured before its first navigation has the
      // console but not the network, and this is the natural retry point.
      await armNetwork(tabId);
      return {
        tabId,
        ...readNetwork(tabId, str(args.include) === "all" ? "all" : "failures"),
      };
    }

    /**
     * Go somewhere in the agent's OWN tab, reusing it rather than breeding tabs.
     *
     * `open_tab` creates unconditionally, which is right for "open this as well"
     * and wrong for the ordinary case of a turn moving from page to page — ten
     * navigations left ten tabs in the user's strip. This reuses the agent's
     * current tab and creates one only when it has none.
     *
     * A `tab_id` is honoured ONLY for a tab the agent owns. Retargeting a tab
     * the user is working in is exactly the kind of harm the group exists to
     * prevent: they would watch their own page navigate away under them.
     */
    case "navigate": {
      const url = str(args.url);
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`navigate needs an http(s) URL, got "${url}"`);
      }
      const explicit = num(args.tab_id);
      if (explicit !== null) {
        if (!(await isAgentTab(explicit))) {
          throw new Error(
            `tab ${explicit} is not one Atlarix opened, so it will not be ` +
              `navigated away from what the user is doing. Use open_tab to get ` +
              `a tab of your own.`,
          );
        }
        await api().tabs.update(explicit, { url });
        await beginCapture(explicit);
        await armNetwork(explicit);
        return { tabId: explicit, url, reused: true };
      }
      const all = await api().tabs.query({});
      for (const t of all) {
        if (t.id !== undefined && (await isAgentTab(t.id))) {
          await api().tabs.update(t.id, { url });
          await beginCapture(t.id);
          await armNetwork(t.id);
          return { tabId: t.id, url, reused: true };
        }
      }
      const tab = await api().tabs.create({ url, active: false });
      if (tab?.id !== undefined && tab.windowId !== undefined) {
        await adoptTab(tab.id, tab.windowId).catch(() => {});
      }
      if (tab?.id !== undefined) {
        await beginCapture(tab.id);
        await armNetwork(tab.id);
      }
      return { tabId: tab?.id ?? null, url, reused: false };
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
      // WATCH IT FROM THE START. Console and network are pushed events, so a
      // buffer opened at read time is empty for a page that already loaded —
      // and an empty console read is indistinguishable from a clean page.
      if (tab?.id !== undefined) {
        await beginCapture(tab.id);
        await armNetwork(tab.id);
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
      // Detaches the debugger and drops the buffer. Without this the tab is
      // gone but its capture is not, and `detachAll` has one more tab to let go
      // of than exists.
      await endCapture(tabId);
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
