/**
 * Per-tab network capture over the Chrome DevTools Protocol, with a webRequest
 * fallback.
 *
 * DevTools is not a data source you can read — it is a CLIENT of this protocol.
 * To get what its Network panel shows, you have to be the one asking. So we
 * attach `webContents.debugger` to each BROWSER TAB and subscribe to `Network.*`.
 *
 * **Browser tabs only — never the app window.** A CDP path that attached to the
 * Atlarix window was deleted in this same release: since v14.15.0 the user's app
 * runs in a WebContentsView (a separate CDP target) so it captured nothing
 * useful, while holding the debugger and blocking the user's own DevTools. The
 * page under test is a different proposition, and there is deliberately no
 * "Open DevTools" affordance on browser tabs to conflict with.
 *
 * Spike findings this file exists to encode (Electron 38.2.2, 2026-08-16):
 *   - No sign of electron#23035 — attaching did not suppress or slow requests.
 *   - `Network.enable` HANGS FOREVER on a tab that has never navigated: attach
 *     resolves, the command never does, with no error. Hence `sendWithTimeout`
 *     and the `about:blank` prime. A silent hang here would present exactly like
 *     the session-restore bug fixed the same day.
 */

import log from "electron-log";
import {
  beginRequest,
  completeRequest,
  createTabNetworkLog,
  flattenHeaders,
  type NetworkEntry,
  type TabNetworkLog,
} from "@/lib/browser/network-entry";

const logger = log.scope("browser_network");

/** Any CDP command must be bounded — see the header. */
const CDP_COMMAND_TIMEOUT_MS = 5_000;

/** Escape hatch: ATLARIX_BROWSER_CDP=0 forces the webRequest fallback. */
function cdpEnabled(): boolean {
  return process.env.ATLARIX_BROWSER_CDP !== "0";
}

type Wc = Electron.WebContents;

async function sendWithTimeout(
  wc: Wc,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return await Promise.race([
    wc.debugger.sendCommand(method, params),
    new Promise((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`CDP ${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`)),
        CDP_COMMAND_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
}

/** Per-window, per-tab logs. Keyed by tab id — never one shared buffer. */
const logsByTab = new Map<number, TabNetworkLog>();

export function networkLogForTab(tabId: number): TabNetworkLog {
  let existing = logsByTab.get(tabId);
  if (!existing) {
    existing = createTabNetworkLog(tabId);
    logsByTab.set(tabId, existing);
  }
  return existing;
}

export function getNetworkEntries(tabId: number): NetworkEntry[] {
  return [...(logsByTab.get(tabId)?.entries ?? [])];
}

/** Every tab that has recorded anything — the Console/Network tab renders one card each. */
export function tabsWithNetworkActivity(): number[] {
  return [...logsByTab.entries()]
    .filter(([, l]) => l.entries.length > 0)
    .map(([id]) => id);
}

export function clearNetworkLog(tabId: number): void {
  logsByTab.delete(tabId);
}

/**
 * Attach CDP network capture to a tab.
 *
 * Best-effort and never throws: a tab whose attach fails still browses normally,
 * it just records through the webRequest fallback instead. Returns whether CDP
 * is live, so the caller can mark the log degraded.
 */
export async function attachNetworkCapture(tabId: number, wc: Wc): Promise<boolean> {
  const tabLog = networkLogForTab(tabId);
  if (!cdpEnabled()) {
    tabLog.degraded = true;
    logger.info(`[network] tab ${tabId}: CDP disabled by env — webRequest fallback`);
    return false;
  }

  try {
    if (wc.debugger.isAttached()) return true;
    wc.debugger.attach("1.3");
  } catch (e) {
    tabLog.degraded = true;
    logger.warn(
      `[network] tab ${tabId}: debugger.attach failed (${e instanceof Error ? e.message : e}) — webRequest fallback`,
    );
    return false;
  }

  // If the user or anything else takes the debugger, degrade rather than pretend.
  wc.debugger.on("detach", (_event, reason) => {
    tabLog.degraded = true;
    logger.warn(`[network] tab ${tabId}: debugger detached (${reason}) — fallback from here`);
  });

  wc.debugger.on("message", (_event, method, params) => {
    try {
      handleCdpEvent(tabLog, tabId, method, params as Record<string, unknown>);
    } catch (err) {
      // Capture must never take down a browser tab.
      logger.warn(`[network] tab ${tabId}: event handler threw: ${String(err)}`);
    }
  });

  try {
    await sendWithTimeout(wc, "Network.enable");
    logger.info(`[network] tab ${tabId}: CDP capture live`);
    return true;
  } catch (e) {
    // The spike's headline failure mode. Degrade loudly rather than sit silent.
    tabLog.degraded = true;
    logger.warn(
      `[network] tab ${tabId}: Network.enable failed (${e instanceof Error ? e.message : e}) — webRequest fallback`,
    );
    try {
      wc.debugger.detach();
    } catch {
      /* already gone */
    }
    return false;
  }
}

export function detachNetworkCapture(tabId: number, wc: Wc): void {
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  } catch {
    /* tab already destroyed */
  }
  clearNetworkLog(tabId);
}

type CdpRequest = {
  requestId?: string;
  request?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string };
  type?: string;
  timestamp?: number;
  response?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    fromDiskCache?: boolean;
    encodedDataLength?: number;
  };
  encodedDataLength?: number;
  errorText?: string;
  canceled?: boolean;
};

function handleCdpEvent(
  tabLog: TabNetworkLog,
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): void {
  const p = params as CdpRequest;
  const id = p.requestId;
  if (!id) return;

  if (method === "Network.requestWillBeSent") {
    beginRequest(tabLog, {
      id,
      tabId,
      url: p.request?.url ?? "",
      method: p.request?.method ?? "GET",
      resourceType: p.type?.toLowerCase(),
      requestHeaders: flattenHeaders(p.request?.headers),
      requestBody: p.request?.postData,
      startedAt: Date.now(),
      source: "cdp",
    });
    return;
  }

  if (method === "Network.responseReceived") {
    const pending = tabLog.pending.get(id);
    if (pending) {
      // Response metadata arrives before the body finishes streaming; hold it on
      // the pending record so loadingFinished can complete in one step.
      pending.status = p.response?.status;
      pending.statusText = p.response?.statusText;
      pending.responseHeaders = flattenHeaders(p.response?.headers);
      pending.fromCache = p.response?.fromDiskCache;
      if (p.type) pending.resourceType = p.type.toLowerCase();
    }
    return;
  }

  if (method === "Network.loadingFinished") {
    completeRequest(
      tabLog,
      id,
      { size: p.encodedDataLength, finishedAt: Date.now() },
      { tabId, url: "", method: "GET", source: "cdp" },
    );
    return;
  }

  if (method === "Network.loadingFailed") {
    completeRequest(
      tabLog,
      id,
      {
        failed: true,
        // A cancelled request is not a fault — pages abort prefetches routinely.
        errorText: p.canceled ? "canceled" : (p.errorText ?? "failed"),
        finishedAt: Date.now(),
      },
      { tabId, url: "", method: "GET", source: "cdp" },
    );
  }
}

/**
 * Fetch a response body ON DEMAND.
 *
 * Expect this to fail often. The spike measured 4/25 and 9/25 retrievable on a
 * heavy page — CDP's buffer evicts bodies aggressively and returns "No resource
 * with given identifier found". A localhost app making a few XHRs should fare far
 * better, but the caller must surface "no longer available" honestly rather than
 * render an empty body as if the response had none.
 */
export async function fetchResponseBody(
  wc: Wc,
  requestId: string,
): Promise<{ body: string; base64: boolean } | { unavailable: string }> {
  try {
    if (!wc.debugger.isAttached()) {
      return { unavailable: "Body capture needs the debugger, which is not attached to this tab." };
    }
    const res = (await sendWithTimeout(wc, "Network.getResponseBody", { requestId })) as {
      body?: string;
      base64Encoded?: boolean;
    };
    if (typeof res?.body !== "string") {
      return { unavailable: "No body was returned for this request." };
    }
    return { body: res.body, base64: Boolean(res.base64Encoded) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The common case, and it is not an error worth alarming about.
    if (/No resource with given identifier/i.test(msg)) {
      return {
        unavailable:
          "This response body is no longer buffered — the browser evicted it. Re-issue the request to inspect it.",
      };
    }
    return { unavailable: `Body unavailable: ${msg}` };
  }
}
