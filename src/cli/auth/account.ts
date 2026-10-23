/**
 * The CLI's own Atlarix session: signing in, who is signed in, signing out.
 *
 * It uses the desktop's Supabase client and secure session store unchanged; the
 * CLI only points the store at its own file (ATLARIX_AUTH_SESSION_STEM, set in
 * desktop-data.ts) and at the desktop's OS key (the electron stub's
 * safeStorage). Signing out here ends this session only (scope "local").
 */
import { spawn } from "node:child_process";
import { signInWithBrowser, type Tokens } from "./browser-sign-in";

/** Keep a session from the sign-in page, or refuse it (the same rules as the desktop). */
export async function acceptSession(t: Tokens): Promise<string> {
  const { getSupabaseClient } = await import("@/lib/auth/supabase-client");
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.auth.setSession(t);
  if (error) throw new Error(`Sign-in failed: ${error.message}`);
  if (!data.user?.email) {
    // An account is keyed on its email (billing, plan checks). The desktop
    // refuses such a session for the same reason.
    await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    throw new Error("This account has no email address. Sign in with a provider that shares your email.");
  }
  // Funnel: Core is usable from this terminal or editor now (the desktop counts its own sign-in).
  const { trackModelConnected } = await import("@/main/lib/analytics");
  await trackModelConnected({ type: "core", provider: "compass" });
  const { noteSignedIn } = await import("@/lib/analytics/account-context");
  await noteSignedIn(data.user.id);
  return data.user.email;
}

let avatarCache: { url: string; data: string | null } | null = null;

/**
 * Who you are as your sign-in provider says: name, picture and provider. The
 * picture comes back as a data: URL (fetched here, at most 256 KB, once per
 * process), so the editor's page shows it without loading anything itself.
 */
export async function currentProfile(): Promise<{ name: string | null; avatar: string | null; provider: string | null }> {
  const { getSession } = await import("@/lib/auth/supabase-client");
  const user = (await getSession().catch(() => null))?.user;
  if (!user) return { name: null, avatar: null, provider: null };
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(meta.full_name) ?? str(meta.name) ?? str(meta.user_name) ?? str(meta.preferred_username);
  const provider = str((user.app_metadata as Record<string, unknown> | undefined)?.provider);
  const url = str(meta.avatar_url) ?? str(meta.picture);
  let avatar: string | null = null;
  if (url && /^https:\/\//.test(url)) {
    if (avatarCache?.url === url) avatar = avatarCache.data;
    else {
      try {
        // A small one: GitHub's default is 460px.
        const small = /avatars\.githubusercontent\.com/.test(url) ? `${url}${url.includes("?") ? "&" : "?"}s=128` : url;
        const res = await fetch(small, { signal: AbortSignal.timeout(4_000) });
        const type = res.headers.get("content-type") ?? "";
        const buf = res.ok && /^image\//.test(type) ? Buffer.from(await res.arrayBuffer()) : null;
        avatar = buf && buf.length <= 256_000 ? `data:${type.split(";")[0]};base64,${buf.toString("base64")}` : null;
      } catch {
        avatar = null;
      }
      avatarCache = { url, data: avatar };
    }
  }
  return { name, avatar, provider: provider === "email" ? "email" : provider };
}

export async function currentEmail(): Promise<string | null> {
  const { getSession } = await import("@/lib/auth/supabase-client");
  try {
    return (await getSession())?.user?.email ?? null;
  } catch {
    return null;
  }
}

export async function signOutCli(): Promise<void> {
  const { signOut } = await import("@/lib/auth/supabase-client");
  await signOut();
}

/** Open a URL in the default browser, without waiting and without a shell. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is also printed for copying */
  }
}

/** The whole browser sign-in, reporting the URL through `onUrl` as soon as it exists. */
export function signInCli(onUrl: (url: string) => void, returnTo?: string): Promise<string> {
  return signInWithBrowser({
    ...(returnTo ? { returnTo } : {}),
    openUrl: (url) => {
      onUrl(url);
      openInBrowser(url);
    },
    acceptSession,
  });
}
