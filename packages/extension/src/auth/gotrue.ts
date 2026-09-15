/**
 * The three GoTrue calls this extension makes, and nothing else.
 *
 * NO `@supabase/supabase-js`, and not merely to keep the dependency count at
 * zero. Its session model is a background auto-refresh timer, and the MV3
 * service worker is torn down after ~30s idle — so the timer is killed, the
 * token quietly rots, and the failure surfaces much later as an unexplained
 * 401. The library is fighting the platform there. What this extension needs is
 * refresh-on-demand, checked against `exp` before each call, which is four
 * `fetch`es against endpoints whose exact shapes are read off auth-js's own
 * source (`GoTrueClient.js`) rather than guessed.
 *
 * `fetch` is injectable on every call that makes one, so the whole module is
 * testable without a network or a browser.
 */

import { CODE_CHALLENGE_METHOD } from "./pkce";
import {
  sessionFromTokenResponse,
  type StoredSession,
  type TokenResponse,
} from "./session";

export interface GoTrueConfig {
  /** The project URL, e.g. `https://<ref>.supabase.co` — no trailing slash. */
  url: string;
  /** The publishable (anon) key. Public by design; RLS is what protects data. */
  anonKey: string;
}

export type OAuthProvider = "google" | "github";

/**
 * The provider consent URL.
 *
 * Pure, so a test can assert the exact query string. The parameter names and
 * the LOWERCASE `s256` are what GoTrue actually receives from supabase-js —
 * `code_challenge_method` is spelled `S256` in RFC 7636 and `s256` on the wire.
 */
export function authorizeUrl(
  cfg: GoTrueConfig,
  opts: {
    provider: OAuthProvider;
    redirectTo: string;
    codeChallenge: string;
  },
): string {
  const params = new URLSearchParams({
    provider: opts.provider,
    redirect_to: opts.redirectTo,
    code_challenge: opts.codeChallenge,
    code_challenge_method: CODE_CHALLENGE_METHOD,
  });
  return `${cfg.url}/auth/v1/authorize?${params.toString()}`;
}

export type RedirectResult =
  | { kind: "code"; code: string }
  | { kind: "error"; error: string; description?: string };

/**
 * Read the outcome out of the URL `launchWebAuthFlow` came back with.
 *
 * READS BOTH THE QUERY AND THE FRAGMENT. The authorization code arrives as
 * `?code=`, but a provider denial can land in either half depending on the
 * provider and the flow, and a parser that only looks at one reports "no code"
 * for a user who explicitly clicked Cancel.
 *
 * Returns a discriminated union rather than throwing, so the error path is a
 * VALUE the caller has to handle. That is the direct lesson from the launchpad
 * PKCE bug recorded in docs/TODO.md: a failure that arrives as a rejection
 * skips every `if (error)` branch written to catch it.
 */
export function parseRedirect(redirectUrl: string): RedirectResult {
  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return {
      kind: "error",
      error: "invalid_redirect",
      description: redirectUrl,
    };
  }
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const pick = (key: string): string | null =>
    parsed.searchParams.get(key) ?? fragment.get(key);

  const error = pick("error");
  if (error) {
    return {
      kind: "error",
      error,
      description: pick("error_description") ?? undefined,
    };
  }
  const code = pick("code");
  if (code) return { kind: "code", code };
  return { kind: "error", error: "no_code", description: redirectUrl };
}

/** A GoTrue error carrying the server's own explanation, never a bare Response. */
export class GoTrueError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoTrueError";
    this.status = status;
  }
}

async function postToken(
  cfg: GoTrueConfig,
  grantType: "pkce" | "refresh_token",
  body: Record<string, string>,
  f: typeof fetch,
): Promise<StoredSession> {
  const res = await f(`${cfg.url}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: {
      apikey: cfg.anonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* a non-JSON body is reported through the status below */
  }

  if (!res.ok) {
    const description =
      (typeof parsed.error_description === "string" &&
        parsed.error_description) ||
      (typeof parsed.msg === "string" && parsed.msg) ||
      (typeof parsed.error === "string" && parsed.error) ||
      text.slice(0, 200) ||
      res.statusText;
    throw new GoTrueError(res.status, description);
  }

  return sessionFromTokenResponse(parsed as unknown as TokenResponse);
}

/**
 * Trade the authorization code for a session.
 *
 * NO `Authorization` header. There is no token yet — this is the call that
 * mints one — and sending an empty or stale bearer here produces a 401 that
 * points at authentication rather than at the exchange.
 */
export function exchangeCode(
  cfg: GoTrueConfig,
  args: { authCode: string; codeVerifier: string },
  f: typeof fetch = fetch,
): Promise<StoredSession> {
  return postToken(
    cfg,
    "pkce",
    { auth_code: args.authCode, code_verifier: args.codeVerifier },
    f,
  );
}

export function refreshSession(
  cfg: GoTrueConfig,
  refreshToken: string,
  f: typeof fetch = fetch,
): Promise<StoredSession> {
  return postToken(cfg, "refresh_token", { refresh_token: refreshToken }, f);
}
