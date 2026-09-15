/**
 * Holding the native-messaging port open, and getting it back when it drops.
 *
 * ══ RECONNECT USES `chrome.alarms`, NOT `setTimeout` ══
 *
 * This is the whole reason `alarms` is in the manifest. A service worker is
 * evicted after ~30 seconds of idleness, and eviction takes every `setTimeout`
 * with it. So a worker that lost its port, scheduled a retry and then went
 * quiet would never retry — the bridge would stay down until the browser
 * restarted, and nothing anywhere would say why. An alarm survives eviction and
 * wakes the worker to run it, which is exactly the shape this needs.
 *
 * Short backoffs still use `setTimeout`, deliberately: `chrome.alarms` has a
 * ONE MINUTE FLOOR for repeating alarms and will not fire a one-shot sooner
 * than about 30 seconds either. A worker that has just lost its port is awake
 * and will stay awake for those first few seconds, so a timer is both available
 * and correct there. The alarm is the long backstop for the case where it is
 * not.
 *
 * ══ NEVER HOT-LOOP ══
 *
 * Every connection attempt SPAWNS A PROCESS — the wrapper, then the relay — and
 * on macOS each spawn is a Gatekeeper evaluation. A tight retry would put a
 * visible load on the machine while achieving nothing, which is the shape of
 * Anthropic's own recorded "reconnect loop" bug. 1s, 2s, 4s, 8s, then a
 * one-minute alarm forever.
 *
 * ══ THE PORT IS ALSO A KEEPALIVE ══
 *
 * A connected `connectNative` port is documented to keep the service worker
 * alive. That is a property a `WebSocket` in a worker does NOT reliably have,
 * and it is one of the reasons native messaging beat a loopback socket here.
 */

import { api } from "../shared/browser-api";
import { serveBridgeRequest, type BridgeRequest } from "./serve";

/** Must match the host manifest's `name` exactly. */
export const NATIVE_HOST = "dev.atlarix.bridge";

/** The alarm that retries after the short backoffs are spent. */
export const RECONNECT_ALARM = "atlarix-bridge-reconnect";

/** 1s, 2s, 4s, 8s — then the alarm takes over. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

interface Port {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (message: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

interface NativeApi {
  runtime: {
    connectNative?: (name: string) => Port;
    lastError?: { message?: string };
    getManifest?: () => { version?: string };
  };
  alarms?: {
    create: (name: string, info: { delayInMinutes?: number; periodInMinutes?: number }) => void;
    clear: (name: string) => Promise<boolean> | void;
  };
}

let port: Port | null = null;
let attempt = 0;
let shortTimer: ReturnType<typeof setTimeout> | undefined;

function native(): NativeApi {
  return api() as unknown as NativeApi;
}

export function isBridgeConnected(): boolean {
  return port !== null;
}

/**
 * Open the port, or schedule another go.
 *
 * SAFE TO CALL REPEATEDLY — on worker startup, from the alarm, and after a
 * disconnect — because a live port short-circuits. The worker is re-entered
 * from several directions and none of them can know whether another already
 * connected.
 */
export function connectBridge(): void {
  if (port) return;

  const connect = native().runtime.connectNative;
  if (typeof connect !== "function") {
    // Firefox, or a build without the permission. Not an error worth retrying.
    return;
  }

  let opened: Port;
  try {
    opened = connect(NATIVE_HOST);
  } catch {
    // Thrown when the host manifest is absent, which is the ordinary state for
    // anyone who has the extension and not the desktop app.
    scheduleReconnect();
    return;
  }

  opened.onMessage.addListener((message: unknown) => {
    void handle(message);
  });

  opened.onDisconnect.addListener(() => {
    port = null;
    // `lastError` must be READ here or Chrome logs "Unchecked runtime.lastError"
    // on every disconnect — noise in the user's console that looks like our bug.
    void native().runtime.lastError?.message;
    scheduleReconnect();
  });

  port = opened;
  attempt = 0;
  void native().alarms?.clear(RECONNECT_ALARM);

  // SENT IMMEDIATELY, because the desktop cannot use a connection it has not
  // been told about: the relay dials in, and until this arrives the app sees a
  // socket with nobody behind it.
  opened.postMessage({
    type: "hello",
    protocol: 1,
    extensionVersion: native().runtime.getManifest?.()?.version ?? "unknown",
    browser: browserName(),
  });
}

async function handle(message: unknown): Promise<void> {
  if (typeof message !== "object" || message === null) return;
  const body = message as Record<string, unknown>;

  // The relay says this when the desktop app is not running. It is an ordinary
  // state, not a failure: back off and wait rather than hammering.
  if (body.type === "atlarix:bridge-unavailable") {
    port?.disconnect();
    port = null;
    scheduleReconnect();
    return;
  }

  if (typeof body.id !== "string" || typeof body.op !== "string") return;
  const reply = await serveBridgeRequest(body as unknown as BridgeRequest);
  // The port can die while an op is in flight — a page that took ten seconds to
  // answer outlives a browser quit. Writing to a dead port throws.
  try {
    port?.postMessage(reply);
  } catch {
    /* the desktop went away; it will ask again */
  }
}

function scheduleReconnect(): void {
  if (shortTimer !== undefined) clearTimeout(shortTimer);

  const delay = BACKOFF_MS[attempt];
  attempt += 1;

  if (delay !== undefined) {
    shortTimer = setTimeout(() => {
      shortTimer = undefined;
      connectBridge();
    }, delay);
    return;
  }

  // Past the short backoffs. An alarm, because by now the worker may well be
  // evicted and a timer would die with it — see the file docblock.
  native().alarms?.create(RECONNECT_ALARM, { periodInMinutes: 1 });
}

/** Wire the alarm to the reconnect. Called once, from the service worker. */
export function installBridgeAlarm(): void {
  const alarms = (api() as unknown as {
    alarms?: { onAlarm?: { addListener: (fn: (a: { name: string }) => void) => void } };
  }).alarms;
  alarms?.onAlarm?.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) connectBridge();
  });
}

/** Best-effort, for the desktop's status line. Chromium forks all say "Chrome". */
function browserName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Brave/.test(ua)) return "brave";
  return "chrome";
}

/** Tests only: forget the module's connection state. */
export function resetBridgeForTest(): void {
  if (shortTimer !== undefined) clearTimeout(shortTimer);
  shortTimer = undefined;
  port = null;
  attempt = 0;
}
