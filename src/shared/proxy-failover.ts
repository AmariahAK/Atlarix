/**
 * The Atlarix Core proxy, with a fallback (item 10, owner 2026-10-22): Railway
 * first, a copy on AWS Lambda when Railway is down. Shared by the app, the CLI
 * (and so ACP and the VS Code panel) and the Chrome extension, so it imports
 * nothing of theirs.
 *
 * WHEN IT FALLS BACK, AND WHEN IT NEVER DOES. Only when the primary cannot be
 * reached (no connection) or answers 502, 503 or 504: the same request goes
 * once to the fallback. Never on a 4xx (an answer, not an outage: a 402 is the
 * balance, a 429 a limit). Never once a response has started: the choice is
 * made on the status line, before any body is read, so a stream never switches
 * half-way. A request whose body cannot be sent twice (a stream) is not
 * retried; it fails as it would have, and the next request goes to the
 * fallback.
 *
 * Nor on a 503 that is the proxy ANSWERING: `free_busy` (every free pool is
 * full). The copy shares that free-tier state, so asking it changes nothing,
 * and the 3-minute hold then sent every later request, paid ones included, to
 * the copy (live QA 2026-10-30). Read from the small JSON body of the 503,
 * which is never a stream.
 *
 * After such a failure the primary is skipped for FALLBACK_HOLD_MS, then tried
 * again. Per process.
 *
 * WHERE THE URL COMES FROM: the hosted core-models.json (`proxy.fallbackUrl`)
 * first, so it changes without a release, else the build's constant, else
 * none, and everything behaves exactly as before. Only https on a host we run
 * on is taken: a tampered config must not be able to send everyone's sign-in
 * token somewhere else.
 */
export const FALLBACK_HOLD_MS = 3 * 60 * 1000;
const FALLBACK_STATUSES = new Set([502, 503, 504]);
const ALLOWED_HOST = /(^|\.)(on\.aws|up\.railway\.app|atlarix\.dev)$/i;

let configured: string | null = null;
let built: string | null = null;
let primaryDownUntil = 0;
let lastSwitchLogged = 0;
type Log = (line: string) => void;
let log: Log = () => {};

/** The fallback's base, or null: https on an allowed host, trailing slashes off. */
export function validFallbackUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || !ALLOWED_HOST.test(u.hostname)) return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** From the hosted core-models.json; a bad value is ignored (and said). */
export function setConfiguredFallback(raw: unknown): void {
  const ok = validFallbackUrl(raw);
  if (raw != null && raw !== "" && !ok) log(`proxy fallback ignored: not https on an allowed host (${String(raw)})`);
  configured = ok;
}

/** The build's constant, used when the hosted config names none. */
export function setBuiltFallback(raw: unknown): void {
  built = validFallbackUrl(raw);
}

export function setProxyFailoverLog(fn: Log): void {
  log = fn;
}

export function fallbackBase(): string | null {
  return configured ?? built;
}

/** Whether a request went to the fallback, for turn analytics (`proxy: "fallback"`). */
export function onFallback(now = Date.now()): boolean {
  return fallbackBase() != null && now < primaryDownUntil;
}

/** The same request on the fallback: `primary`'s path (and /v1) under the fallback's origin. */
function onFallbackUrl(url: string, primary: string, fallback: string): string {
  const p = primary.replace(/\/+$/, "").replace(/\/v1$/, "");
  const f = fallback.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.startsWith(p) ? f + url.slice(p.length) : url;
}

/** A body that can be sent a second time as it is. */
function replayable(body: unknown): boolean {
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof Blob !== "undefined" && body instanceof Blob)
  );
}

function markPrimaryDown(why: string, now: number): void {
  primaryDownUntil = now + FALLBACK_HOLD_MS;
  if (now - lastSwitchLogged > FALLBACK_HOLD_MS) {
    lastSwitchLogged = now;
    log(`Core proxy unreachable (${why}): using the fallback for ${Math.round(FALLBACK_HOLD_MS / 60000)} min`);
  }
}

/**
 * `fetch` for a call to the proxy whose base is `primary`. Any URL not under
 * the primary goes through untouched.
 */
export async function proxyFetch(
  primary: string,
  input: string | URL,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  const url = String(input);
  const fallback = fallbackBase();
  const p = primary.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (!fallback || !url.startsWith(p)) return fetchImpl(input, init);
  if (now() < primaryDownUntil) return fetchImpl(onFallbackUrl(url, primary, fallback), init);

  let res: Response;
  try {
    res = await fetchImpl(input, init);
  } catch (e) {
    // Aborted by the caller (Stop): not an outage.
    if ((e as { name?: string })?.name === "AbortError" || init?.signal?.aborted) throw e;
    markPrimaryDown("no connection", now());
    if (!replayable(init?.body)) throw e;
    return fetchImpl(onFallbackUrl(url, primary, fallback), init);
  }
  if (!FALLBACK_STATUSES.has(res.status)) return res;
  if (res.status === 503 && (await answeredBusy(res))) return res;
  markPrimaryDown(String(res.status), now());
  if (!replayable(init?.body)) return res;
  // Its body is never read: drop it before asking the fallback.
  void res.body?.cancel().catch(() => {});
  return fetchImpl(onFallbackUrl(url, primary, fallback), init);
}

/** The proxy answered "all free pools are busy": an answer, not an outage. */
async function answeredBusy(res: Response): Promise<boolean> {
  try {
    return /"error"\s*:\s*"free_busy"/.test(await res.clone().text());
  } catch {
    return false;
  }
}

/** Test hook. */
export function __resetProxyFailoverForTests(): void {
  configured = null;
  built = null;
  primaryDownUntil = 0;
  lastSwitchLogged = 0;
  log = () => {};
}
