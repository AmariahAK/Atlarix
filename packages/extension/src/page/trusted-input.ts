/**
 * Trusted keyboard and pointer input, via `chrome.debugger`.
 *
 * WHY THIS EXISTS AT ALL, AND WHY NOTHING CHEAPER WILL DO. A synthetic
 * `KeyboardEvent` dispatched from JavaScript carries `isTrusted: false`, and the
 * browser refuses to run default actions for it: Enter does not submit a form,
 * and CSS `:hover` never fires. `src/lib/tools/browser.ts` records the same
 * finding under `key / hover / scroll` — the synthetic version "looks right in
 * code and silently does nothing", which is the worst failure shape there is,
 * because the agent reports success.
 *
 * `chrome.debugger` is the only API that emits `isTrusted: true`. There is no
 * second option and no polyfill; Firefox has none at all, which is why
 * `shared/browser-api.ts` treats `trustedInput` as a capability that can be
 * absent rather than something to assume.
 *
 * THE COST IS REAL AND IS WHY THIS IS SCOPED. Attaching:
 *   - shows the user a banner saying Atlarix is debugging this tab;
 *   - EVICTS DevTools from that tab — only one debugger client at a time, so a
 *     developer with DevTools open loses it, or we fail to attach;
 *   - gives us a protocol that can do far more than send a keystroke.
 *
 * So attach is refused for any tab outside the agent's own group, checked
 * against the browser rather than a list we keep. The user's other tabs never
 * banner and keep their DevTools.
 *
 * DETACH IS A NORMAL PATH, NOT AN ERROR. That banner has a Cancel button, and
 * the user is entitled to press it mid-run. `onDetach` also fires when the tab
 * navigates to a page we may not touch, or closes. Treating it as a fault would
 * turn an ordinary user action into a crash; treating it as silence would leave
 * every later keystroke going nowhere.
 */

import { api, unsupportedActionMessage } from "../shared/browser-api";
import { isAgentTab } from "../tabs/group";

/** The CDP version we speak. 1.3 is the stable protocol. */
const PROTOCOL_VERSION = "1.3";

/** Tabs we currently hold a debugger session on. */
const attached = new Set<number>();

/** Raised when trusted input cannot be delivered, saying why. */
export class TrustedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedInputError";
  }
}

/**
 * Start listening for the user taking the debugger back.
 *
 * Call once per context. Without it, a cancelled banner leaves `attached`
 * claiming a session that is gone, and every later command fails with a raw
 * protocol error instead of a re-attach.
 */
export function watchDetach(
  onDetach?: (tabId: number, reason: string) => void,
): void {
  api().debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    onDetach?.(source.tabId, reason);
  });
}

/**
 * Attach to a tab, if we are allowed to and are not already.
 *
 * Refuses any tab outside the agent's group. That check is the containment:
 * without it, one bad tab id would put a debugger banner on the user's bank tab.
 */
export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;

  if (!(await isAgentTab(tabId))) {
    throw new TrustedInputError(
      `Refusing to attach a debugger to tab ${tabId}: it is not in Atlarix's tab group. ` +
        `Trusted input is only available in tabs Atlarix opened — attaching elsewhere ` +
        `would banner the user's own tab and take away its DevTools.`,
    );
  }

  try {
    await api().debugger.attach({ tabId }, PROTOCOL_VERSION);
    attached.add(tabId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The commonest cause by far, and the only one with a user-facing remedy.
    if (/another debugger|already attached/i.test(message)) {
      throw new TrustedInputError(
        `Another debugger is already attached to this tab — usually DevTools. ` +
          `Close DevTools on that tab and try again. (${message})`,
      );
    }
    throw new TrustedInputError(`Could not attach to the tab: ${message}`);
  }
}

/**
 * Give every tab back.
 *
 * CALLED WHEN A TURN ENDS, and it is the whole reason Chrome's banner goes away.
 * The infobar — `"Atlarix" started debugging this browser` — is shown by Chrome
 * for exactly as long as a debugger is attached, and its wording, including the
 * quotes around the name, is Chromium's own string. We cannot change a character
 * of it. What we CAN do is not be attached when we are not working, which is the
 * difference between a banner that appears while the agent types into a form and
 * one that sits there for the rest of the day.
 *
 * Until 2026-09-13 `detach` had ZERO production callers: every `press_key` or
 * `hover` attached, and nothing ever let go.
 */
export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((tabId) => detach(tabId)));
}

/** Give the tab back. Safe to call when not attached. */
export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await api().debugger.detach({ tabId });
  } catch {
    // Already gone — the tab closed, or the user pressed Cancel between the
    // check and the call. Nothing to repair.
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

async function send(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await attach(tabId);
  try {
    await api().debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A detach between attach and send is a race the user can cause by pressing
    // Cancel. Drop the stale record so the next call re-attaches rather than
    // failing the same way forever.
    if (/detached|not attached/i.test(message)) {
      attached.delete(tabId);
    }
    throw new TrustedInputError(`${method} failed: ${message}`);
  }
}

/**
 * The keys worth naming, with the codes CDP wants.
 *
 * `windowsVirtualKeyCode` is what makes a key press a real one: without it the
 * event arrives with `keyCode: 0`, which every framework's "was that Enter?"
 * check reads as no. That is the same class of silent nothing this module
 * exists to avoid, one layer down.
 */
const NAMED_KEYS: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

export function isNamedKey(name: string): boolean {
  return name in NAMED_KEYS;
}

/** Every key this build can press, for an error message that helps. */
export function namedKeys(): string[] {
  return Object.keys(NAMED_KEYS);
}

/**
 * Press and release a named key.
 *
 * `rawKeyDown` rather than `keyDown` when there is no text: CDP treats
 * `keyDown` with no `text` as a key that produces no character, and some pages
 * miss it. The pairing below is what Puppeteer and Playwright both settled on.
 */
export async function pressKey(tabId: number, name: string): Promise<void> {
  const spec = NAMED_KEYS[name];
  if (!spec) {
    throw new TrustedInputError(
      `Unknown key "${name}". This build can press: ${namedKeys().join(", ")}.`,
    );
  }

  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  };

  await send(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: spec.text ? "keyDown" : "rawKeyDown",
    ...(spec.text ? { text: spec.text } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

/**
 * Type a string as real keystrokes.
 *
 * `Input.insertText` would be one call and is tempting, but it does NOT produce
 * per-character key events — so an autocomplete that opens on keydown, or a
 * field that validates as you type, sees a value appear from nowhere. Typing
 * character by character is slower and is what the page expects.
 */
export async function typeText(tabId: number, text: string): Promise<void> {
  for (const char of Array.from(text)) {
    await send(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      text: char,
    });
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", text: char });
  }
}

/**
 * Move the pointer, which is the only way CSS `:hover` fires.
 *
 * A `mouseover` dispatched from JavaScript does not drive `:hover` at all: that
 * is a compositor-level state, not an event listener, so a menu that opens on
 * hover stays shut while the event log says it was hovered.
 */
export async function movePointer(
  tabId: number,
  x: number,
  y: number,
): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
}

/** A real click at a point: move, press, release. */
export async function clickAt(
  tabId: number,
  x: number,
  y: number,
): Promise<void> {
  // The move first is not ceremony. Pages that open a menu on hover and act on
  // the click expect the pointer to have arrived before it pressed.
  await movePointer(tabId, x, y);
  const base = { x, y, button: "left" as const, clickCount: 1 };
  await send(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mousePressed",
    buttons: 1,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    ...base,
    type: "mouseReleased",
    buttons: 0,
  });
}

/**
 * The message to give a model when this browser has no trusted input.
 *
 * Re-exported from the capability layer so callers here do not invent their own
 * wording. Degrading LOUDLY is the rule: never dispatch a synthetic substitute
 * and report success.
 */
export function unavailableMessage(action: string): string {
  return unsupportedActionMessage(action, "trustedInput");
}
