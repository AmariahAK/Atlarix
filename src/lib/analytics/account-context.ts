/**
 * At sign-in: who this is to Sentry, and where this account started.
 *
 * - Crash reports carry the account id (never the email), so a report can be
 *   matched to the person who hit it. The app's renderer reports go through
 *   the main process and get the same id there. Cleared at sign-out.
 * - `record_client_seen`, once per process per account: which Atlarix (app,
 *   cli, acp, vscode), its version and the OS. The first sign-in's values are
 *   kept as the account's first; the latest version and OS follow. Before
 *   this only a model turn recorded where someone started, and most new
 *   accounts never ran one (owner, 2026-10-23).
 *
 * Like the usage counts it is kept with the account, not covered by the
 * analytics answer (the privacy page says so), and off when the editor
 * running us has its own telemetry off. Never blocks or breaks sign-in.
 */
import os from "node:os";
import { atlarixSurface } from "@/ipc/shared/core_proxy";

type SetUser = (user: { id: string } | null) => void;
type RecordSeen = (args: { p_surface: string; p_app_version: string | null; p_os: string }) => Promise<void>;

const seen = new Set<string>();
let setUserImpl: SetUser | null = null;
let recordImpl: RecordSeen | null = null;

async function sentrySetUser(): Promise<SetUser> {
  if (setUserImpl) return setUserImpl;
  const Sentry = await import("@sentry/electron/main");
  return (user) => Sentry.setUser(user);
}

async function recordSeen(args: Parameters<RecordSeen>[0]): Promise<void> {
  if (recordImpl) return recordImpl(args);
  const { getSupabaseClient } = await import("@/lib/auth/supabase-client");
  await getSupabaseClient().rpc("record_client_seen", args as never);
}

async function appVersion(): Promise<string | null> {
  try {
    const { app } = await import("electron");
    return app.getVersion() || null;
  } catch {
    return null;
  }
}

/** The signed-in account. Call on every session update; sends once per account per process. */
export async function noteSignedIn(userId: string): Promise<void> {
  if (!userId) return;
  try {
    (await sentrySetUser())({ id: userId });
  } catch {
    /* a crash reporter must never break sign-in */
  }
  if (process.env.ATLARIX_HOST_TELEMETRY === "off" || seen.has(userId)) return;
  seen.add(userId);
  try {
    await recordSeen({ p_surface: atlarixSurface(), p_app_version: await appVersion(), p_os: os.platform() });
  } catch {
    /* nothing to retry: the next launch records it */
  }
}

export async function noteSignedOut(): Promise<void> {
  try {
    (await sentrySetUser())(null);
  } catch {
    /* noop */
  }
}

/** Tests: where calls go, and a clean slate. */
export function __setAccountContextForTests(deps: { setUser?: SetUser; record?: RecordSeen } | null): void {
  setUserImpl = deps?.setUser ?? null;
  recordImpl = deps?.record ?? null;
  seen.clear();
}
