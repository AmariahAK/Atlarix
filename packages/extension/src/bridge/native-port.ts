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

/** Requests THIS side started (protocol 2), waiting on the desktop's ext-reply. */
const extPending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let extNext = 1;

/** The key this browser profile's peer id is kept under. */
export const PROFILE_ID_KEY = "atlarix.profileId.v1";

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
    failExtPending("the Atlarix desktop app or CLI went away before it answered");
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
    // WHICH BUILD, not just which release. The version follows the app's and so
    // is identical across rebuilds of one release; this is a hash of the
    // sources. It is what makes a stale extension load visible in the desktop
    // log rather than something to be deduced from changed error wording.
    buildId: __ATLARIX_BUILD_ID__,
    browser: browserName(),
  });
  void sayFullHello(opened);
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

  // The desktop answering a request this side started (sendExtRequest).
  if (body.type === "ext-reply" && typeof body.id === "string") {
    const waiting = extPending.get(body.id);
    if (!waiting) return;
    extPending.delete(body.id);
    clearTimeout(waiting.timer);
    if (body.ok === true) waiting.resolve(body.result);
    else waiting.reject(new Error(typeof body.error === "string" ? body.error : "the desktop refused it"));
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

/**
 * Which Chromium fork this is, for the desktop's status line.
 *
 * BRAVE IS NOT DETECTABLE FROM THE USER AGENT, and the first version of this
 * function assumed it was. Measured against a real Brave profile: it reported
 * "chrome", because Brave deliberately ships Chrome's exact UA string as an
 * anti-fingerprinting measure — the `/Brave/` test could never have matched.
 * The supported signal is `navigator.brave.isBrave()`, which is a promise, so
 * the answer is refined and re-sent rather than awaited before saying hello.
 *
 * Edge and Opera DO mark the UA, so those two are honest.
 */
function browserName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  return "chrome";
}

/**
 * The second hello: protocol 2, this profile's peer id, and the real browser
 * name. A second hello on a connection replaces the first on the desktop.
 *
 * Deliberately AFTER the first rather than instead of it. The first is what the
 * desktop waits on to know a browser is attached, and both pieces here are
 * promises (storage, and Brave's `navigator.brave.isBrave()` — Brave ships
 * Chrome's exact UA, so it is not detectable any other way).
 */
async function sayFullHello(opened: Port): Promise<void> {
  let browser = browserName();
  try {
    const brave = (navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    if (typeof brave?.isBrave === "function" && (await brave.isBrave())) browser = "brave";
  } catch {
    /* keep the UA's answer */
  }
  const profileId = await peerProfileId();
  if (port !== opened) return; // reconnected meanwhile; that connection says its own
  try {
    opened.postMessage({
      type: "hello",
      protocol: 2,
      extensionVersion: native().runtime.getManifest?.()?.version ?? "unknown",
      buildId: __ATLARIX_BUILD_ID__,
      browser,
      ...(profileId ? { profileId } : {}),
    });
  } catch {
    /* the port died; the reconnect says hello again */
  }
}

/**
 * A random id for this browser profile, made once. The desktop addresses this
 * browser by it, and two profiles (or Chrome and Brave) stay two sessions.
 */
export async function peerProfileId(): Promise<string | null> {
  try {
    const local = api().storage.local;
    const got = await local.get(PROFILE_ID_KEY);
    const have = got[PROFILE_ID_KEY];
    if (typeof have === "string" && have.length >= 8) return have;
    const made = crypto.randomUUID();
    await local.set({ [PROFILE_ID_KEY]: made });
    return made;
  } catch {
    return null;
  }
}

/**
 * Ask the desktop for something (protocol 2): the one op today is `peer_send`,
 * the side-panel agent's reply to a session that handed it a task.
 */
export function sendExtRequest(
  op: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<unknown> {
  const p = port;
  if (!p) {
    return Promise.reject(
      new Error("not connected to the Atlarix desktop app or CLI — open one and try again"),
    );
  }
  const id = `e${extNext++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      extPending.delete(id);
      reject(
        new Error(
          "the Atlarix desktop app or CLI did not answer (it may be older than this extension)",
        ),
      );
    }, timeoutMs);
    extPending.set(id, { resolve, reject, timer });
    try {
      p.postMessage({ type: "ext-request", id, op, args });
    } catch (err) {
      clearTimeout(timer);
      extPending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function failExtPending(reason: string): void {
  for (const [id, w] of extPending) {
    clearTimeout(w.timer);
    w.reject(new Error(reason));
    extPending.delete(id);
  }
}

/** Tests only: forget the module's connection state. */
export function resetBridgeForTest(): void {
  failExtPending("reset");
  extNext = 1;
  if (shortTimer !== undefined) clearTimeout(shortTimer);
  shortTimer = undefined;
  port = null;
  attempt = 0;
}
