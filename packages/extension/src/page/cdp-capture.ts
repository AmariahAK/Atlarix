/**
 * Console and network capture for the agent's own tabs, over CDP.
 *
 * ══ WHY THIS EXISTS, AND WHAT IT REPLACES ══
 *
 * `browser_inspect(mode:"console")` used to refuse over the extension with
 * "needs instrumentation only Atlarix's built-in browser installs". The first
 * half of that was true — nothing here captured a console — and the second half
 * was false: this package holds the `debugger` permission and already attaches
 * CDP for keystrokes (`trusted-input.ts`). The events below ride that same
 * attached session. It was the second refusal to claim a capability was
 * impossible when it was merely unwritten; `action:"key"` was the first.
 *
 * ══ CAPTURE STARTS WHEN THE TAB OPENS, NOT WHEN SOMEONE READS ══
 *
 * These are PUSHED events. Attaching at read time yields an empty buffer for a
 * page that has already loaded and logged — and an empty console read is
 * indistinguishable from a clean page, which is the exact lie this whole
 * feature exists to stop telling. So `beginCapture` runs when the agent creates
 * the tab, and a read is a buffer dump.
 *
 * ══ THE ENABLE ORDER IS NOT ARBITRARY ══
 *
 *     attach -> Runtime.enable -> (navigate) -> Network.enable
 *
 * `Network.enable` HANGS on a tab that has never navigated — recorded in
 * TRAPS.md from v14.31.0, where it cost a turn. `Runtime.enable` is safe
 * immediately, so console capture starts at once and network capture arms after
 * the first navigation.
 *
 * ══ THE BANNER IS THE PRICE, AND IT IS A REAL CHANGE ══
 *
 * Chrome shows "Atlarix started debugging this browser" for exactly as long as
 * a debugger is attached, and `trusted-input.detachAll`'s docblock is explicit
 * that letting go is what takes it down. Capturing means staying attached for
 * the life of an agent tab, so on those tabs the banner now persists. That is
 * accepted rather than overlooked: it is Atlarix's own tab, the user did not
 * open it, and the sentence Chrome shows is true. It is never done to a tab the
 * user opened — `attach` refuses anything outside the agent's group.
 */

import { api } from "../shared/browser-api";
import { attach, detach } from "./trusted-input";
import type {
  BrowserConsoleLevel,
  BrowserSurfaceError,
} from "@/lib/browser/error-hook";
import type { NetworkEntry } from "@/lib/browser/network-entry";

/**
 * Bounded, because an agent tab left on a chatty page would otherwise grow
 * until the worker died. Oldest out first: the most recent output is what a
 * question about "what just happened" is asking for.
 */
const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;

/** See `armNetwork` — this guards a documented HANG, not a slow call. */
const NETWORK_ENABLE_TIMEOUT_MS = 2_000;

interface TabCapture {
  console: BrowserSurfaceError[];
  /** Keyed by CDP requestId so a response can find the request it completes. */
  network: Map<string, NetworkEntry>;
  /** Insertion order, for the ring buffer's eviction. */
  networkOrder: string[];
  networkArmed: boolean;
  /**
   * Why capture is NOT running, when it is not.
   *
   * The difference between "the page logged nothing" and "we could not watch"
   * is the entire point, so it is carried rather than inferred from an empty
   * array. DevTools on the tab is the common cause.
   */
  unavailable?: string;
}

const captures = new Map<number, TabCapture>();
let listening = false;

function bufferFor(tabId: number): TabCapture | undefined {
  return captures.get(tabId);
}

/** CDP's console vocabulary is wider than ours; fold the rest into `log`. */
function levelOf(type: string): BrowserConsoleLevel {
  if (type === "error" || type === "assert") return "error";
  if (type === "warning") return "warning";
  if (type === "info") return "info";
  if (type === "debug") return "debug";
  return "log";
}

/** Render one CDP RemoteObject the way a console would show it. */
function renderArg(arg: unknown): string {
  const o = arg as {
    type?: string;
    value?: unknown;
    description?: string;
    unserializableValue?: string;
  };
  if (!o || typeof o !== "object") return String(arg);
  if (o.type === "string") return String(o.value ?? "");
  if (o.unserializableValue) return o.unserializableValue;
  if (o.value !== undefined) return JSON.stringify(o.value) ?? String(o.value);
  // `description` is what DevTools shows for an object or a function, and for
  // an Error it is the message PLUS the stack — which is the useful part.
  return o.description ?? o.type ?? "";
}

function pushConsole(tabId: number, entry: BrowserSurfaceError): void {
  const cap = bufferFor(tabId);
  if (!cap) return;
  cap.console.push(entry);
  if (cap.console.length > MAX_CONSOLE) cap.console.shift();
}

function upsertNetwork(
  tabId: number,
  id: string,
  patch: Partial<NetworkEntry>,
): void {
  const cap = bufferFor(tabId);
  if (!cap) return;
  const existing = cap.network.get(id);
  if (existing) {
    Object.assign(existing, patch);
    return;
  }
  cap.network.set(id, {
    id,
    tabId,
    url: "",
    method: "",
    startedAt: Date.now(),
    source: "cdp",
    ...patch,
  } as NetworkEntry);
  cap.networkOrder.push(id);
  if (cap.networkOrder.length > MAX_NETWORK) {
    const evicted = cap.networkOrder.shift();
    if (evicted) cap.network.delete(evicted);
  }
}

/**
 * ONE listener for every attached tab, installed once.
 *
 * Registered lazily rather than at module load: this module is imported by the
 * bridge, and a listener added on every service-worker wake would accumulate.
 */
function ensureListening(): void {
  if (listening) return;
  listening = true;

  api().debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId === undefined || !captures.has(tabId)) return;
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(p.args) ? p.args : [];
      pushConsole(tabId, {
        type: "console-error",
        level: levelOf(String(p.type ?? "log")),
        message: args.map(renderArg).join(" "),
        timestamp: Date.now(),
        tabId,
      });
      return;
    }

    if (method === "Runtime.exceptionThrown") {
      const details = (p.exceptionDetails ?? {}) as Record<string, unknown>;
      const exception = (details.exception ?? {}) as Record<string, unknown>;
      // `description` carries the stack for a thrown Error; `text` is the bare
      // message and is all there is for a thrown non-Error.
      const description =
        typeof exception.description === "string"
          ? exception.description
          : undefined;
      pushConsole(tabId, {
        type: "console-error",
        level: "error",
        message: description ?? String(details.text ?? "Uncaught exception"),
        stack: description,
        timestamp: Date.now(),
        tabId,
        url: typeof details.url === "string" ? details.url : undefined,
      });
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const request = (p.request ?? {}) as Record<string, unknown>;
      upsertNetwork(tabId, String(p.requestId), {
        url: String(request.url ?? ""),
        method: String(request.method ?? "GET"),
        resourceType:
          typeof p.type === "string" ? p.type.toLowerCase() : undefined,
        requestHeaders: request.headers as Record<string, string> | undefined,
        startedAt: Date.now(),
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const response = (p.response ?? {}) as Record<string, unknown>;
      upsertNetwork(tabId, String(p.requestId), {
        status: Number(response.status ?? 0) || undefined,
        statusText:
          typeof response.statusText === "string" && response.statusText
            ? response.statusText
            : undefined,
        responseHeaders: response.headers as Record<string, string> | undefined,
        fromCache: Boolean(response.fromDiskCache),
        resourceType:
          typeof p.type === "string" ? p.type.toLowerCase() : undefined,
      });
      return;
    }

    if (method === "Network.loadingFinished") {
      const cap = bufferFor(tabId);
      const entry = cap?.network.get(String(p.requestId));
      const finishedAt = Date.now();
      upsertNetwork(tabId, String(p.requestId), {
        finishedAt,
        durationMs: entry ? finishedAt - entry.startedAt : undefined,
        size: Number(p.encodedDataLength ?? 0) || undefined,
      });
      return;
    }

    if (method === "Network.loadingFailed") {
      const cap = bufferFor(tabId);
      const entry = cap?.network.get(String(p.requestId));
      const finishedAt = Date.now();
      upsertNetwork(tabId, String(p.requestId), {
        failed: true,
        errorText: String(p.errorText ?? "request failed"),
        finishedAt,
        durationMs: entry ? finishedAt - entry.startedAt : undefined,
      });
    }
  });
}

/**
 * Start watching a tab. Safe to call twice.
 *
 * Never throws: a tab whose debugger is held by DevTools is a tab the agent can
 * still read and click, and failing `open_tab` over it would trade a whole
 * capability for a diagnostic one. The reason is stored and surfaced by the
 * READ instead, which is where someone can act on it.
 */
export async function beginCapture(tabId: number): Promise<void> {
  if (captures.has(tabId)) return;
  const cap: TabCapture = {
    console: [],
    network: new Map(),
    networkOrder: [],
    networkArmed: false,
  };
  captures.set(tabId, cap);
  ensureListening();

  try {
    await attach(tabId);
    await api().debugger.sendCommand({ tabId }, "Runtime.enable", {});
  } catch (err) {
    cap.unavailable = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Arm network capture, AFTER the tab has navigated.
 *
 * Separate from `beginCapture` because `Network.enable` hangs on a tab that has
 * never navigated. Called once the agent has pointed the tab somewhere.
 */
export async function armNetwork(tabId: number): Promise<void> {
  const cap = bufferFor(tabId);
  if (!cap || cap.networkArmed || cap.unavailable) return;
  cap.networkArmed = true;
  try {
    // RACED, BECAUSE THE TRAP IS A HANG AND NOT AN ERROR. `Network.enable` on a
    // tab that has not navigated never settles, and a bare `await` here would
    // hold the bridged request open until the desktop's 30s timeout — turning a
    // missing capability into a frozen turn. A timeout degrades it to an honest
    // "not armed" that the read reports and the next call retries.
    await Promise.race([
      api().debugger.sendCommand({ tabId }, "Network.enable", {}),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Network.enable did not respond")),
          NETWORK_ENABLE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    cap.networkArmed = false;
    // NOT `unavailable`. A timeout here means "not armed yet", and the tab may
    // navigate a moment later — recording it as unavailable would make a
    // recoverable state permanent for the life of the tab.
    if (!/did not respond/.test(String(err))) {
      cap.unavailable = err instanceof Error ? err.message : String(err);
    }
  }
}

/** Stop watching and give the tab back. Safe when never started. */
export async function endCapture(tabId: number): Promise<void> {
  if (!captures.delete(tabId)) return;
  await detach(tabId);
}

export interface CaptureRead<T> {
  entries: T[];
  /** Set when capture was not running; never combined with entries. */
  unavailable?: string;
}

export function readConsole(
  tabId: number,
  level: "all" | "errors" | "warnings" = "all",
): CaptureRead<BrowserSurfaceError> {
  const cap = bufferFor(tabId);
  if (!cap) {
    return {
      entries: [],
      unavailable:
        "Atlarix was not watching this tab, so nothing was recorded. Console " +
        "capture starts when Atlarix opens a tab; a tab it did not open has no " +
        "history to read.",
    };
  }
  if (cap.unavailable) {
    return {
      entries: [],
      unavailable:
        `Atlarix could not watch this tab's console: ${cap.unavailable}. ` +
        `This is NOT an empty console — the page may have logged plenty.`,
    };
  }
  const entries =
    level === "errors"
      ? cap.console.filter((e) => e.level === "error")
      : level === "warnings"
        ? cap.console.filter((e) => e.level === "warning" || e.level === "error")
        : cap.console;
  return { entries: [...entries] };
}

export function readNetwork(
  tabId: number,
  include: "failures" | "all" = "failures",
): CaptureRead<NetworkEntry> {
  const cap = bufferFor(tabId);
  if (!cap) {
    return {
      entries: [],
      unavailable:
        "Atlarix was not watching this tab, so no requests were recorded.",
    };
  }
  if (cap.unavailable) {
    return {
      entries: [],
      unavailable:
        `Atlarix could not watch this tab's network: ${cap.unavailable}. ` +
        `This is NOT "the page made no requests".`,
    };
  }
  if (!cap.networkArmed) {
    return {
      entries: [],
      unavailable:
        "Network capture is not armed on this tab — it arms after the tab " +
        "navigates. Navigate first, then read.",
    };
  }
  const all = cap.networkOrder
    .map((id) => cap.network.get(id))
    .filter((e): e is NetworkEntry => e !== undefined);
  const entries =
    include === "all"
      ? all
      : all.filter((e) => e.failed === true || (e.status ?? 0) >= 400);
  return { entries };
}

/** For tests and for `close_tab`, which must not leave a buffer behind. */
export function isCapturing(tabId: number): boolean {
  return captures.has(tabId);
}
