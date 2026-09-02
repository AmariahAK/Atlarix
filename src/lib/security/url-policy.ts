/**
 * Outbound URL policy for main-process fetches (SSRF mitigation).
 */

import dns from "node:dns/promises";
import net from "node:net";
import { containsSecret } from "./redact-secrets";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Egress control (A5/H-4): a recognizable secret shape in the URL path/query is
 * an exfiltration attempt, not a legitimate request — block it regardless of
 * host. High-confidence shapes only (see redact-secrets), so false positives are
 * negligible. Applies to every outbound channel that validates via
 * assertUrlAllowed (read_url's safeFetch and the browser tool's navigate).
 */
function assertNoSecretInUrl(parsed: URL): void {
  const raw = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* keep raw if malformed percent-encoding */
  }
  if (containsSecret(raw) || containsSecret(decoded)) {
    throw new Error(
      "URL blocked: it contains what looks like a secret/credential in the path or query. Outbound requests must not carry secrets (possible exfiltration).",
    );
  }
}

export type UrlPolicyOptions = {
  /** Allow private/loopback/link-local when request origin matches one of these (normalized origins). */
  trustedOrigins?: string[];
  /**
   * Allow LOOPBACK targets (localhost, 127.0.0.0/8, ::1) — used by the desktop
   * browser & preview surfaces, whose entire purpose is viewing the user's own
   * local dev server. Other private/reserved ranges (LAN 10/172.16/192.168,
   * link-local 169.254, cloud metadata) stay blocked, so this is NOT a general
   * SSRF bypass — it only unblocks the user's own machine.
   */
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxRedirects?: number;
};

function normalizeOrigin(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeTrustedOrigins(origins: string[] | undefined): Set<string> {
  const set = new Set<string>();
  for (const o of origins ?? []) {
    const trimmed = o.trim();
    if (!trimmed) continue;
    try {
      set.add(normalizeOrigin(trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed));
    } catch {
      // skip invalid
    }
  }
  return set;
}

function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
    if (lower.startsWith("fe80")) return true; // fe80::/10
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      if (net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
    }
    return false;
  }
  return false;
}

function isHostnameBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIP(h)) return isPrivateOrReservedIp(h);
  return false;
}

/** Loopback only (the user's own machine) — a subset of private/reserved. */
function isLoopbackIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return ip.split(".").map(Number)[0] === 127;
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      if (net.isIPv4(v4)) return isLoopbackIp(v4);
    }
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIP(h)) return isLoopbackIp(h);
  return false;
}

async function resolveAndCheckHost(
  hostname: string,
  trustedOrigins: Set<string>,
  requestOrigin: string,
  allowLoopback: boolean,
): Promise<void> {
  const allowPrivate = trustedOrigins.has(requestOrigin);
  const okLoopbackHost = allowLoopback && isLoopbackHost(hostname);
  const okLoopbackIp = (ip: string) => allowLoopback && isLoopbackIp(ip);

  if (isHostnameBlocked(hostname)) {
    if (allowPrivate || okLoopbackHost) return;
    throw new Error(`URL blocked: host "${hostname}" resolves to a private or reserved address`);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname) && !allowPrivate && !okLoopbackIp(hostname)) {
      throw new Error(`URL blocked: IP address "${hostname}" is not allowed`);
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`URL blocked: could not resolve host "${hostname}"`);
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address) && !allowPrivate && !okLoopbackIp(address)) {
      throw new Error(
        `URL blocked: host "${hostname}" resolves to disallowed address ${address}`,
      );
    }
  }
}

/**
 * Validate a URL before fetch. Throws on disallowed targets.
 */
export async function assertUrlAllowed(
  url: string,
  options?: UrlPolicyOptions,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL blocked: only http and https are allowed (got ${parsed.protocol})`);
  }

  if (parsed.username || parsed.password) {
    throw new Error("URL blocked: credentials in URL are not allowed");
  }

  assertNoSecretInUrl(parsed);

  const trusted = normalizeTrustedOrigins(options?.trustedOrigins);
  const origin = normalizeOrigin(parsed.href);
  await resolveAndCheckHost(parsed.hostname, trusted, origin, options?.allowLoopback === true);

  return parsed;
}

export type SafeFetchOptions = UrlPolicyOptions & {
  maxRedirects?: number;
};

/**
 * Fetch with URL policy, redirect cap, and timeout.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<Response> {
  const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const trustedOrigins = options?.trustedOrigins;

  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    await assertUrlAllowed(currentUrl, { trustedOrigins, timeoutMs });

    const signal =
      init?.signal ??
      AbortSignal.timeout(timeoutMs);

    const response = await fetch(currentUrl, {
      ...init,
      signal,
      redirect: "manual",
    });

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      if (redirectCount >= maxRedirects) {
        throw new Error(`URL blocked: too many redirects (max ${maxRedirects})`);
      }
      redirectCount += 1;
      const location = response.headers.get("location")!;
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return response;
  }
}

/** Normalize a SearxNG base URL for trusted-origin matching. */
export function normalizeSearxngBaseUrl(url: string | null | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    const base = url.trim().replace(/\/+$/, "");
    return normalizeOrigin(base.startsWith("http") ? base : `http://${base}`);
  } catch {
    return undefined;
  }
}
