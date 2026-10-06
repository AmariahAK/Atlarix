/**
 * A Core bearer token handed to a headless run, used INSTEAD of the Supabase
 * session (see core_proxy.ts). Its own module, free of `process`, because the
 * renderer's import graph reaches resolve-toolset.ts, which asks whether one is
 * set: importing core_proxy.ts there crashed the renderer at load
 * ("process is not defined").
 */
let pinnedCoreToken: string | null = null;

export function setPinnedCoreToken(token: string | null): void {
  pinnedCoreToken = token && token.trim() ? token.trim() : null;
}

export function getPinnedCoreToken(): string | null {
  return pinnedCoreToken;
}
