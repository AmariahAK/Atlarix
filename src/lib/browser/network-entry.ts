/**
 * The shape of one captured network request — shared by the extension, which
 * records it over CDP (`packages/extension/src/page/cdp-capture.ts`), and the
 * desktop, which renders it for `browser_inspect(mode:"network")`.
 *
 * Dependency-free on purpose: the extension imports it, and an MV3 service
 * worker cannot resolve anything Electron- or Node-shaped. The per-tab stores,
 * the webRequest fallback tier and the injected fetch wrapper went with the
 * in-app agent browser in v14.52.0.
 */

/** Which tier produced an entry. Only `cdp` is produced since v14.52.0. */
export type NetworkSource = "cdp" | "webrequest" | "injected";

export type NetworkEntry = {
  /** CDP `requestId`. Unique per tab. */
  id: string;
  tabId: number;
  url: string;
  method: string;
  /** `document` | `xhr` | `fetch` | `script` | `image` | … — a label, not an enum. */
  resourceType?: string;
  status?: number;
  statusText?: string;
  /** Request start → finish. Undefined while in flight. */
  durationMs?: number;
  /** Bytes (CDP `encodedDataLength`). Undefined means "unknown", never "zero". */
  size?: number;
  fromCache?: boolean;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  /** Request payload when the tier could see one. */
  requestBody?: string;
  /** Response payload — fetched ON DEMAND, so usually unset on a listing. */
  responseBody?: string;
  /** True when `responseBody` was cut at a cap. */
  responseBodyTruncated?: boolean;
  /** Transport-level failure (DNS, refused, aborted) — distinct from a 4xx/5xx. */
  failed?: boolean;
  errorText?: string;
  startedAt: number;
  finishedAt?: number;
  source: NetworkSource;
};

/** Failures worth calling out: transport errors and 4xx/5xx alike. */
export function isFailure(entry: NetworkEntry): boolean {
  if (entry.failed) return true;
  return typeof entry.status === "number" && entry.status >= 400;
}

/** One request as a row of text, for `browser_inspect(mode:"network")`. */
export function formatNetworkRow(entry: NetworkEntry): string {
  const status = entry.failed
    ? `FAILED ${entry.errorText ?? ""}`.trim()
    : (entry.status ?? "—");
  const bits = [
    entry.resourceType,
    // Undefined means UNKNOWN, not zero.
    entry.durationMs != null ? `${entry.durationMs}ms` : null,
    entry.size != null ? `${entry.size}B` : null,
    entry.fromCache ? "cached" : null,
  ].filter(Boolean);
  return `• [${status}] ${entry.method} ${entry.url}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}
