/**
 * Answering the desktop app. One switch, no agent, no model, no approvals.
 *
 * ══ WHAT THIS FILE MUST NOT IMPORT, AND WHY IT IS A TEST ══
 *
 * Not `agent/loop.ts`, not `tools/dispatch.ts`, not `core/client.ts`, and
 * nothing under `panel/`. `dispatch.ts` is the tempting one — it already knows
 * how to click a ref — and importing it would drag the model client and the
 * approval plumbing into the service worker, where they would run INSIDE a
 * bridged request, raising a prompt in a panel that may not even be open for an
 * action the user already initiated in the app.
 *
 * The rule is enforced by `bridge-imports.test.ts` rather than by this comment,
 * because the import that breaks it will look entirely reasonable.
 *
 * ══ WHO DECIDES WHETHER AN ACTION IS ALLOWED ══
 *
 * CORRECTED 2026-09-18. This section used to say the desktop "already asked" —
 * that its own approval flow ran before the request was sent. **It does not.**
 * Verified end to end: the desktop's `browser.ts` handlers go straight to
 * `requestChrome`, and neither contains an approval call; `src/lib/browser/always-ask.ts` has
 * no production importer under the desktop `src/` at all — its only non-test
 * importer is THIS extension's `tools/dispatch.ts`. There is no approval,
 * permission or confirmation step anywhere on the bridge path.
 *
 * So the accurate statement is: NOTHING GATES THIS PATH, on either side. Not a
 * relocated decision — an absent one.
 *
 * The only lever that exists is the deny-only permission ruleset in the
 * desktop's tool-execute funnel, and it is weaker than it sounds: opt-in and
 * off unless a workspace has a rules file, and name-only in its matching, so it
 * cannot gate a destination origin. It can refuse the tool outright. It cannot
 * ask.
 *
 * WHY THAT IS STILL THE RIGHT SHAPE HERE, which is the part the old wording got
 * right for the wrong reason: the turn is user-initiated in the app, and a
 * prompt raised in a browser window the user is not looking at is a question
 * they cannot answer. That is not a theory — it blocked three rounds of live
 * testing, and each "fix" was another layer in front of a door that should have
 * been open. Host access being a REQUIRED manifest permission since 2026-09-17
 * is what makes the door open; the extension's per-site list is deliberately
 * not consulted here either.
 *
 * The real asymmetry, stated precisely, because the Web Store copy leans on it:
 * the PANEL path has two gates — a per-origin grant that suspends the turn and
 * renders an approval card on first contact with a domain, plus an always-ask
 * classifier on click/fill/press_key that a site grant cannot override. The
 * BRIDGE path has neither. Broad access exists for the desktop integration
 * while the in-browser agent keeps a self-imposed limit. If a user narrows Site
 * access from chrome://extensions, Chrome refuses the injection and its own
 * error surfaces — that is the one external check on this path.
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
  MAX_SEARCH_RESULTS,
  PAGE_TEXT_MAX_CHARS,
  type A11yFindResult,
  type A11ySnapshot,
  type PageActionResult,
  type PageTextResult,
} from "@/lib/browser/page-scripts";
import { formatFind, formatSnapshot } from "@/lib/browser/a11y-format";
import { api } from "../shared/browser-api";
import {
  activeTab,
  injectPackagedFile,
  runInPage,
  runPageFunction,
} from "../page/inject";
import {
  atlarixDesignSnapshot,
  atlarixVisualLint,
  type DesignSnapshot,
  type VisualLintRaw,
} from "@/lib/browser/page-scripts/visual";
import { VISUAL_LINT_ARGS } from "@/lib/browser/visual-report";
import {
  adoptTab,
  groupTitle,
  isAgentTab,
  noteAgentClosingTab,
  setGroupTitle,
  type GroupClient,
} from "../tabs/group";

/**
 * Which Atlarix sent the request: the desktop app, or the `atlarix` CLI
 * (`args.client`, added by the desktop's browser-target.ts). Each drives its own
 * tab group. A request without it comes from an app older than the CLI.
 */
function clientOf(args: Record<string, unknown>): GroupClient {
  return args.client === "cli" ? "cli" : "app";
}
import {
  armNetwork,
  beginCapture,
  endCapture,
  readConsole,
  readNetwork,
  readNetworkBody,
} from "../page/cdp-capture";
import {
  attach,
  captureScreenshot,
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
    if (await isAgentTab(t.id, clientOf(args))) {
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

async function markDriven(tabId: number, client: GroupClient = "app"): Promise<void> {
  try {
    await runInPage(tabId, { op: "overlay", state: "on" });
  } catch {
    /* a restricted or vanished page; the action itself will report properly */
  }
  try {
    const tab = await api().tabs.get(tabId);
    if (tab?.windowId !== undefined) {
      await setGroupTitle(tab.windowId, groupTitle(client, true), client);
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
      void releaseTab(tabId, client);
    }, OVERLAY_LINGER_MS),
  );
}

async function releaseTab(tabId: number, client: GroupClient = "app"): Promise<void> {
  try {
    await runInPage(tabId, { op: "overlay", state: "off" });
  } catch {
    /* closed, navigated away, or never granted — nothing to take down */
  }
  try {
    const tab = await api().tabs.get(tabId);
    if (tab?.windowId !== undefined) await setGroupTitle(tab.windowId, groupTitle(client), client);
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
async function requireOwnTabForInput(tabId: number, what: string, client: GroupClient = "app"): Promise<void> {
  if (await isAgentTab(tabId, client)) return;
  throw new Error(
    `${what} needs a real keystroke or pointer move, which means attaching a ` +
      `debugger to the tab — that shows a banner and takes DevTools away from ` +
      `whoever is using it. Tab ${tabId} is the user's own, so nothing was ` +
      `done. Either click the control you wanted to trigger, or open the page ` +
      `yourself (tabs operation:"create") and work in that copy.`,
  );
}

/**
 * How long `navigate` / `open_tab` wait for the page to finish loading.
 *
 * Under the desktop's 30s bridge timeout with room to spare. A page that is
 * still loading after this is reported as such (`loaded: false`) rather than
 * failed — a slow dev server is not an error.
 */
const LOAD_WAIT_MS = 15_000;

/**
 * Resolve when `tabId` reports `status: "complete"`, or false on timeout.
 *
 * CALL IT BEFORE STARTING THE NAVIGATION. A fast page can complete before a
 * listener added afterwards exists, and the wait would then run to its timeout
 * on a page that loaded instantly.
 */
function waitForTabLoad(tabId: number, timeoutMs = LOAD_WAIT_MS): Promise<boolean> {
  const tabs = api().tabs;
  return new Promise((resolve) => {
    let settled = false;
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(ok: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tabs.onUpdated.removeListener(listener);
      resolve(ok);
    }
    tabs.onUpdated.addListener(listener);
  });
}

/**
 * Load `url` in one of the agent's tabs with capture ALREADY RUNNING.
 *
 * Console and network are pushed events: a buffer opened after the page
 * started loading misses its first logs and requests, and a missed log reads
 * exactly like a clean page. So capture is begun first (a no-op on a tab that
 * is already watched), the navigation second, and the network armed while the
 * load is in flight — `Network.enable` hangs on a tab that has not navigated.
 */
async function loadInAgentTab(tabId: number, url: string) {
  await beginCapture(tabId);
  const loaded = waitForTabLoad(tabId);
  await api().tabs.update(tabId, { url });
  await armNetwork(tabId);
  const ok = await loaded;
  const tab = await api().tabs.get(tabId).catch(() => undefined);
  return {
    tabId,
    url: tab?.url || url,
    title: tab?.title ?? "",
    loaded: ok,
    navigatedAt: Date.now(),
  };
}

/**
 * A fresh background tab in the agent's group, at about:blank, so capture can
 * attach before the real page loads (see `loadInAgentTab`).
 */
async function createAgentTab(client: GroupClient = "app"): Promise<number> {
  const tab = await api().tabs.create({ url: "about:blank", active: false });
  if (tab?.id === undefined) throw new Error("the browser did not open a tab");
  if (tab.windowId !== undefined) {
    await adoptTab(tab.id, tab.windowId, undefined, client).catch(() => {});
  }
  return tab.id;
}

/**
 * Ops the desktop may ask for.
 *
 * DELIBERATELY SHORTER THAN THE PANEL'S TOOL LIST. Everything here maps onto a
 * kernel op, a portable page function, a CDP buffer, or a `chrome.tabs` call
 * that exists — never a stub, because an empty read that only LOOKS like a
 * clean page is the worst possible lie. Since v14.52.0 this is the desktop
 * agent's ONLY browser, so it carries everything the in-app one did.
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
  const client = clientOf(args);
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
          agent: t.id !== undefined && (await isAgentTab(t.id, client)),
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
      await markDriven(tabId, client);
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
      await markDriven(tabId, client);
      const res = await runInPage<PageTextResult>(tabId, {
        op: "text",
        selector: str(args.selector) || undefined,
        max: PAGE_TEXT_MAX_CHARS,
      });
      if (!res.ok) throw new Error(res.error ?? "the page text could not be read");
      return { tabId, url, text: res.text, clipped: res.clipped };
    }

    /**
     * A PNG of what the tab shows. The agent's own tabs go over CDP, which
     * needs no focus change (their tabs sit in the background by design). The
     * user's tab can only be captured while it is the one in front —
     * `captureVisibleTab` photographs the visible tab and nothing else — and a
     * user tab that is not in front is refused rather than switched to, because
     * taking focus is the one thing this bridge never does.
     *
     * Not marked as driven: the green frame would land in the picture.
     */
    case "screenshot": {
      const tabId = await targetTab(args);
      const tab = await api().tabs.get(tabId);
      const url = tab?.url ?? "";
      if (await isAgentTab(tabId, client)) {
        const shot = await captureScreenshot(tabId);
        return {
          tabId,
          url,
          title: tab?.title ?? "",
          mimeType: "image/png",
          data: shot.data,
          width: shot.width,
          height: shot.height,
        };
      }
      if (tab?.active && tab.windowId !== undefined) {
        const dataUrl = await api().tabs.captureVisibleTab(tab.windowId, {
          format: "png",
        });
        return {
          tabId,
          url,
          title: tab.title ?? "",
          mimeType: "image/png",
          data: dataUrl.replace(/^data:image\/png;base64,/, ""),
        };
      }
      throw new Error(
        `Tab ${tabId} is the user's and is not the one on screen, so it cannot ` +
          `be photographed without switching to it — which this never does. ` +
          `Open the page yourself (tabs operation:"create") and screenshot ` +
          `that copy, or read its text instead.`,
      );
    }

    case "find_on_page": {
      const tabId = await targetTab(args);
      const url = await tabUrl(tabId);
      await markDriven(tabId, client);
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
      await markDriven(tabId, client);
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
      await markDriven(tabId, client);
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
        await markDriven(tabId, client);
        return runInPage<PageActionResult>(tabId, { op: "resolve", ref });
      }
      const direction = str(args.direction);
      if (direction === "left" || direction === "right") {
        throw new Error(
          `scrolling ${direction} is not supported — the page kernel scrolls ` +
            `vertically. Scroll a horizontally-scrolling element into view by ` +
            `its ref instead, or read the page text to reach its content.`,
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
      await markDriven(tabId, client);
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
      await requireOwnTabForInput(tabId, `Pressing ${name}`, client);
      await markDriven(tabId, client);
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
      await requireOwnTabForInput(tabId, "Hovering", client);
      await markDriven(tabId, client);
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
        if (!(await isAgentTab(explicit, client))) {
          throw new Error(
            `tab ${explicit} is not one Atlarix opened, so it will not be ` +
              `navigated away from what the user is doing. Use open_tab to get ` +
              `a tab of your own.`,
          );
        }
        return { ...(await loadInAgentTab(explicit, url)), reused: true };
      }
      const all = await api().tabs.query({});
      for (const t of all) {
        if (t.id !== undefined && (await isAgentTab(t.id, client))) {
          return { ...(await loadInAgentTab(t.id, url)), reused: true };
        }
      }
      const tabId = await createAgentTab(client);
      return { ...(await loadInAgentTab(tabId, url)), reused: false };
    }

    /**
     * Always a NEW tab in the agent's group — "open this as well". Same order
     * as `navigate`: capture first, then the page, then wait for it.
     */
    case "open_tab": {
      const url = str(args.url).trim();
      // NO URL IS A BLANK TAB, as in Claude in Chrome: `tabs_create_mcp` opens
      // an empty tab and `navigate` fills it. Models trained on that ask for a
      // "second tab" first and a page second; refusing the first step meant no
      // tab and no group ever appeared. The blank tab is already in the group,
      // so the user sees it the moment the agent asks for it.
      if (!url) {
        const tabId = await createAgentTab(client);
        return { tabId, url: "about:blank", title: "", loaded: true, blank: true };
      }
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`open_tab needs an http(s) URL, got "${url}"`);
      }
      const tabId = await createAgentTab(client);
      return loadInAgentTab(tabId, url);
    }

    /**
     * The visual report: blank render, broken images, invisible text,
     * collapsed containers, overlap, axe contrast/name rules, CLS.
     *
     * NOT marked as driven: the green frame is part of the page it would
     * measure. axe is injected from the packaged file first; if that fails the
     * report still runs and says the contrast checks did not.
     */
    case "visual": {
      const tabId = await targetTab(args);
      const url = await tabUrl(tabId);
      await injectPackagedFile(tabId, "vendor/axe.min.js");
      const raw = await runPageFunction<VisualLintRaw, [typeof VISUAL_LINT_ARGS]>(
        tabId,
        atlarixVisualLint,
        [VISUAL_LINT_ARGS],
      );
      return { tabId, url, raw };
    }

    /** Palette, type scale, spacing and layout regions, for "remake this". */
    case "design": {
      const tabId = await targetTab(args);
      const url = await tabUrl(tabId);
      const snapshot = await runPageFunction<DesignSnapshot, []>(
        tabId,
        atlarixDesignSnapshot,
        [],
      );
      return { tabId, url, snapshot };
    }

    /** One request's headers and its response body, fetched on demand. */
    case "network_body": {
      const tabId = await targetTab(args);
      return { tabId, ...(await readNetworkBody(tabId, str(args.request_id))) };
    }

    /**
     * A web search for an Atlarix that has no browser of its own (the CLI):
     * the engine's results page in a background tab of the caller's group,
     * read with the same page op the panel's search uses, then closed. Brave
     * first; DuckDuckGo when Brave gives nothing readable (usually its bot
     * check). `challenged` says the engines refused rather than found nothing.
     */
    case "search": {
      const query = str(args.query).trim();
      if (!query) throw new Error("search needs a query");
      const max = Math.min(Number(args.max) || MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
      const engines = [
        ["brave", `https://search.brave.com/search?q=${encodeURIComponent(query)}`],
        ["duckduckgo", `https://duckduckgo.com/?q=${encodeURIComponent(query)}`],
      ] as const;
      const tabId = await createAgentTab(client);
      try {
        for (const [engine, url] of engines) {
          await loadInAgentTab(tabId, url);
          const payload = await runInPage<{ results?: unknown[] }>(tabId, {
            op: "search-results",
            max,
          }).catch(() => ({ results: [] }));
          const results = payload.results ?? [];
          if (results.length > 0) return { engine, results, challenged: false };
        }
        return { engine: null, results: [], challenged: true };
      } finally {
        // The agent emptying its own group is not the user's stop gesture.
        noteAgentClosingTab();
        await endCapture(tabId).catch(() => {});
        await api().tabs.remove(tabId).catch(() => {});
      }
    }

    case "close_tab": {
      const tabId = num(args.tab_id);
      if (tabId === null) throw new Error("close_tab needs tab_id");
      // ONLY TABS ATLARIX OPENED. The panel enforces the same rule and it is
      // not negotiable across surfaces: the user's own tabs are not ours to
      // close, and a desktop request is not a reason to change that.
      if (!(await isAgentTab(tabId, client))) {
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
