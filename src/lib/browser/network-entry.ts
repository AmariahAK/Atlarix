/**
 * Network capture: the shared, dependency-free pieces (no electron import) so
 * they can be unit-tested and reused by the renderer.
 *
 * Capture itself has two tiers, decided per tab at attach time:
 *
 *   - **CDP** (`webContents.debugger` + `Network.enable`) — the same pipe
 *     DevTools uses: real timing, transfer size, and response bodies on demand.
 *     A 2026-08-16 spike on Electron 38.2.2 found no sign of electron#23035
 *     (attach did not suppress or slow requests) and clean survival across
 *     navigation and tab close.
 *   - **webRequest** — the fallback when attach fails. Complete request
 *     inventory, but no bodies and no phase timing. The same spike measured CDP
 *     reporting MORE requests than webRequest for one load (47 vs 39), so these
 *     are not interchangeable inventories and the UI should say which it used.
 *
 * Storage is PER TAB, deliberately. A single shared buffer means one chatty tab
 * evicts another's history — the same bug console and network had before they
 * were split.
 */

/**
 * Which tier produced an entry. Surfaced so the UI can be honest about gaps.
 *
 * `injected` is not a third inventory — the page-side `fetch`/XHR wrapper only
 * ever supplies BODIES, which it attaches to a `webrequest` entry. It appears as
 * a source only when the wrapper saw a request webRequest did not.
 */
export type NetworkSource = "cdp" | "webrequest" | "injected";

export type NetworkEntry = {
  /** CDP `requestId`, or a synthesized id on the fallback tier. Unique per tab. */
  id: string;
  tabId: number;
  url: string;
  method: string;
  /** `document` | `xhr` | `fetch` | `script` | `image` | … — vocabulary differs
   * slightly between tiers, so treat it as a label, not an enum. */
  resourceType?: string;
  status?: number;
  statusText?: string;
  /** Request start → finish. Undefined while in flight. */
  durationMs?: number;
  /**
   * Bytes. CDP reports `encodedDataLength`; the fallback can only read
   * `content-length`, which is absent on chunked or compressed responses — so
   * undefined means "unknown", never "zero".
   */
  size?: number;
  fromCache?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** Request payload when the tier could see one. */
  requestBody?: string;
  /**
   * Response payload. On the CDP tier this is fetched ON DEMAND and may never be
   * set; on the fallback tier the injected wrapper supplies it for `fetch`/XHR
   * only, so a `document` or `script` row legitimately has none.
   */
  responseBody?: string;
  /** True when `responseBody` was cut at the wrapper's cap. */
  responseBodyTruncated?: boolean;
  /** Transport-level failure (DNS, refused, aborted) — distinct from a 4xx/5xx. */
  failed?: boolean;
  errorText?: string;
  startedAt: number;
  finishedAt?: number;
  source: NetworkSource;
};

/**
 * Per-tab cap. Generous because a single page load routinely issues a few
 * hundred requests, and the point of the tab is to look back over one.
 */
export const NETWORK_ENTRIES_PER_TAB_MAX = 500;

/**
 * How many unclaimed response bodies to hold. Small on purpose: an orphan means
 * the two fallback tiers disagreed about a request, which should be rare, and an
 * unbounded map here would be a memory leak driven by page traffic.
 */
export const NETWORK_ORPHAN_BODIES_MAX = 50;

/** A tab's request log, newest last. */
export type TabNetworkLog = {
  tabId: number;
  entries: NetworkEntry[];
  /** In-flight requests awaiting their response, keyed by tier request id. */
  pending: Map<string, NetworkEntry>;
  /** True once this tab fell back off CDP — shown in the UI, not hidden. */
  degraded: boolean;
  /**
   * Bodies from the injected wrapper that arrived before (or without) the
   * webRequest entry they belong to, keyed by `METHOD url`. Claimed on
   * completion. See `attachResponseBody`.
   */
  orphanBodies: Map<string, { body: string; truncated: boolean }>;
};

export function createTabNetworkLog(tabId: number): TabNetworkLog {
  return {
    tabId,
    entries: [],
    pending: new Map(),
    degraded: false,
    orphanBodies: new Map(),
  };
}

/** Correlation key for the injected tier, which has no request id to share. */
export function bodyKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * Record a started request. Held in `pending` rather than `entries` so an
 * in-flight request can be completed in place when its response arrives, without
 * scanning the log.
 */
export function beginRequest(log: TabNetworkLog, entry: NetworkEntry): void {
  log.pending.set(entry.id, entry);
}

/**
 * Complete a started request and move it into the log.
 *
 * A response for an unknown id still lands — capture can begin mid-flight (we
 * attach after the tab exists), and half a record beats silently dropping it.
 */
export function completeRequest(
  log: TabNetworkLog,
  id: string,
  patch: Partial<NetworkEntry>,
  fallback?: Pick<NetworkEntry, "url" | "method" | "tabId" | "source">,
): NetworkEntry | null {
  const started = log.pending.get(id);
  if (started) log.pending.delete(id);
  const base: NetworkEntry | null =
    started ??
    (fallback
      ? {
          id,
          startedAt: patch.finishedAt ?? Date.now(),
          ...fallback,
        }
      : null);
  if (!base) return null;

  const finishedAt = patch.finishedAt ?? Date.now();
  const merged: NetworkEntry = {
    ...base,
    ...patch,
    finishedAt,
    // Only a request we actually saw START has a duration. A synthesized entry
    // would otherwise report 0ms, which reads as a measurement rather than as
    // the "we joined late" that it is.
    durationMs:
      patch.durationMs ??
      (started ? Math.max(0, finishedAt - started.startedAt) : undefined),
  };

  // The injected wrapper resolves its body AFTER the response completes, so it
  // usually finds this entry already here. It can also win the race, in which
  // case the body is waiting to be claimed.
  if (merged.responseBody === undefined && merged.url) {
    const key = bodyKey(merged.method, merged.url);
    const orphan = log.orphanBodies.get(key);
    if (orphan) {
      log.orphanBodies.delete(key);
      merged.responseBody = orphan.body;
      merged.responseBodyTruncated = orphan.truncated;
    }
  }

  log.entries.push(merged);
  if (log.entries.length > NETWORK_ENTRIES_PER_TAB_MAX) {
    log.entries = log.entries.slice(-NETWORK_ENTRIES_PER_TAB_MAX);
  }
  return merged;
}

/**
 * Attach a response body captured page-side to the request it belongs to.
 *
 * The injected wrapper has no request id to share with webRequest, so match on
 * `METHOD url`, newest first, taking the most recent entry that does not already
 * have a body — a polled endpoint hit ten times should get ten distinct bodies,
 * not ten copies of the first.
 *
 * Returns whether it landed on an entry. When it does not, the body is held for
 * `completeRequest` to claim rather than dropped: on a page whose requests
 * webRequest never reported, this is the only record that exists.
 */
export function attachResponseBody(
  log: TabNetworkLog,
  captured: { method: string; url: string; body: string; truncated: boolean },
): boolean {
  const key = bodyKey(captured.method, captured.url);
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const entry = log.entries[i];
    if (entry.responseBody !== undefined) continue;
    if (bodyKey(entry.method, entry.url) !== key) continue;
    entry.responseBody = captured.body;
    entry.responseBodyTruncated = captured.truncated;
    return true;
  }
  log.orphanBodies.set(key, { body: captured.body, truncated: captured.truncated });
  if (log.orphanBodies.size > NETWORK_ORPHAN_BODIES_MAX) {
    // Map iterates in insertion order, so this evicts the oldest.
    const oldest = log.orphanBodies.keys().next();
    if (!oldest.done) log.orphanBodies.delete(oldest.value);
  }
  return false;
}

/** Header arrays (webRequest) and header strings (CDP) → one flat shape. */
export function flattenHeaders(
  headers: Record<string, string | string[]> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** `content-length` when the server sent one. Undefined = unknown, not zero. */
export function sizeFromHeaders(
  headers: Record<string, string> | undefined,
): number | undefined {
  const raw = headers?.["content-length"];
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Failures worth calling out: transport errors and 4xx/5xx alike. */
export function isFailure(entry: NetworkEntry): boolean {
  if (entry.failed) return true;
  return typeof entry.status === "number" && entry.status >= 400;
}
