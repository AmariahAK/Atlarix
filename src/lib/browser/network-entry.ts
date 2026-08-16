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

/** Which tier produced an entry. Surfaced so the UI can be honest about gaps. */
export type NetworkSource = "cdp" | "webrequest";

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

/** A tab's request log, newest last. */
export type TabNetworkLog = {
  tabId: number;
  entries: NetworkEntry[];
  /** In-flight requests awaiting their response, keyed by tier request id. */
  pending: Map<string, NetworkEntry>;
  /** True once this tab fell back off CDP — shown in the UI, not hidden. */
  degraded: boolean;
};

export function createTabNetworkLog(tabId: number): TabNetworkLog {
  return { tabId, entries: [], pending: new Map(), degraded: false };
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
    durationMs:
      patch.durationMs ??
      (base.startedAt ? Math.max(0, finishedAt - base.startedAt) : undefined),
  };

  log.entries.push(merged);
  if (log.entries.length > NETWORK_ENTRIES_PER_TAB_MAX) {
    log.entries = log.entries.slice(-NETWORK_ENTRIES_PER_TAB_MAX);
  }
  return merged;
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
