/**
 * The interactive CLI works on the DESKTOP APP's data: the same chats, sessions
 * and settings, in the same folder. Imported first by the interactive entry, so
 * the environment is set before anything (the electron stub, the database, the
 * settings reader) resolves where user data lives.
 *
 * Batch runs (`atlarix run`, benchmarks, the cloud agent) never come here: they
 * keep their own throwaway folder and must not touch a person's desktop data.
 */
import os from "node:os";
import path from "node:path";

/** Electron's `app.getPath("userData")` for the packaged app named "Atlarix". */
export function desktopUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Atlarix");
  if (platform === "win32") {
    return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Atlarix");
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Atlarix");
}

export function enterDesktopDataMode(): string {
  const dir = process.env.ATLARIX_USER_DATA_DIR ?? desktopUserDataDir();
  process.env.ATLARIX_USER_DATA_DIR = dir;
  // The database init never deletes a shared file, whatever fails.
  process.env.ATLARIX_DB_SHARED = "1";
  // How this process appears in __atlarix_clients ("close the Atlarix CLI …").
  process.env.ATLARIX_CLIENT_PROGRAM = "Atlarix CLI";
  // The ledger label for Core spend from here.
  process.env.ATLARIX_SURFACE ??= "cli";
  // Its own sign-in session file beside the desktop's (supabase-auth-cli.enc).
  process.env.ATLARIX_AUTH_SESSION_STEM ??= "supabase-auth-cli";
  return dir;
}
