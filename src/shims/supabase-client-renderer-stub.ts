/**
 * Renderer stub — Supabase auth runs in the main process; UI uses IPC.
 */
export const DEEP_LINK_PROTOCOL = "atlarix";
export const AUTH_CALLBACK_PATH = "/auth/callback";
// Must stay byte-identical to the main-process constant, which must itself be
// byte-identical to a Supabase Redirect URLs entry. See supabase-client.ts.
export const AUTH_CALLBACK_URL = `${DEEP_LINK_PROTOCOL}://auth/callback`;

export function getSupabaseClient(): never {
  throw new Error("Supabase client is only available in the main process");
}

export async function getSession() {
  return null;
}

export async function restoreAuthSessionOnStartup(): Promise<void> {}

export function cancelPendingOAuthTimeout(): void {}

export async function getOnboardingCompleted(): Promise<boolean> {
  return true;
}

export async function setOnboardingCompleted(_value: boolean): Promise<void> {}

export type OAuthProvider = "google" | "github";

export type UserPlanDb = "free" | "pro";

export async function getUser(): Promise<null> {
  return null;
}

export async function getUserPlan(_userId: string): Promise<UserPlanDb> {
  return "free";
}

export async function isUserBanned(_userId: string): Promise<boolean> {
  return false;
}

export async function getEffectiveTier(
  _userId: string,
  _ownPlan?: UserPlanDb,
): Promise<UserPlanDb> {
  return "free";
}

export async function signInWithOAuth(
  _provider: OAuthProvider,
): Promise<{ error: Error | null }> {
  return {
    error: new Error("Supabase client is only available in the main process"),
  };
}

export async function signOut(): Promise<void> {}

export function onAuthStateChange(
  _callback: (session: null) => void,
): () => void {
  return () => {};
}

export async function handleAuthCallback(_url: string): Promise<{
  session: null;
  error: Error | null;
}> {
  return {
    session: null,
    error: new Error("Supabase client is only available in the main process"),
  };
}
