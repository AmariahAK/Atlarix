import os from "node:os";
import path from "node:path";
import { desktopUserDataDir } from "@/cli/desktop-data";
import { normalizeAppPath } from "@/lib/canonical-app-path";

/**
 * Where Atlarix keeps a person's own files outside any project: the CLI's model
 * choice and recents, global permission rules, agent memory, the CLI log and
 * update stamp. Normally `~/.atlarix`.
 *
 * A scratch profile (ATLARIX_USER_DATA_DIR naming a folder other than the
 * desktop app's own) keeps them inside that folder, so a test run never reads or
 * changes the person's: a QA run picked the owner's model and fell back to paid
 * Core. The interactive CLI sets ATLARIX_USER_DATA_DIR to the desktop's folder
 * (desktop-data.ts), so a real user's files stay where they are.
 *
 * ATLARIX_HOME_DIR names the folder outright: `atlarix run` and `--provider-url`
 * keep the person's rules and memory while their database is elsewhere.
 *
 * Every real launch reaches the desktop's folder: the VS Code extension and the
 * Chrome host set no data folder (the CLI then enters desktop mode); the app's
 * "Continue in terminal" passes only its own scratch folder, which a person's
 * app does not have; a Store (MSIX) app's folder is virtualized, so the CLI,
 * outside the package, computes the same %APPDATA%\Atlarix it sees.
 */
export function atlarixHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (env.ATLARIX_HOME_DIR) return env.ATLARIX_HOME_DIR;
  const userData = env.ATLARIX_USER_DATA_DIR;
  if (userData && normalizeAppPath(userData) !== normalizeAppPath(desktopUserDataDir(platform, env, home))) {
    return path.join(userData, "atlarix-home");
  }
  return path.join(home, ".atlarix");
}
