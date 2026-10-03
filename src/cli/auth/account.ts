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
  return data.user.email;
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
export function signInCli(onUrl: (url: string) => void): Promise<string> {
  return signInWithBrowser({
    openUrl: (url) => {
      onUrl(url);
      openInBrowser(url);
    },
    acceptSession,
  });
}
