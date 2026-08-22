/**
 * What to tell someone when the database will not open.
 *
 * The old dialog said "Atlarix could not initialize its database. Please restart
 * the app." — advice that is wrong for **every** case that can reach it.
 * `initializeDatabase` already retries once, and before retrying it DELETES the
 * sqlite files (`deleteSqliteDbFiles`), plus it pre-emptively unlinks a file under
 * 100 bytes. So the one thing a restart could accomplish has already been
 * attempted automatically and failed. A user who restarts gets the identical
 * dialog and no next step; observed live 2026-08-21.
 *
 * What can actually reach the dialog is a much shorter list than "something went
 * wrong with the database", and the right advice differs sharply between the
 * entries — which is the reason this exists as a classifier rather than better
 * prose. In particular the DOWNGRADE case must never be told to reinstall over its
 * data: their database is fine and the app is too old for it.
 *
 * Pure and dependency-free on purpose: the dialog wiring in `main.ts` is not
 * unit-testable, and this is where the decisions are.
 */

import { UnknownDrizzleMigrationHashError } from "../db/migrate_atlarix";

export type DatabaseFailureKind =
  /** The native sqlite binding will not load — ABI mismatch, quarantined, missing. */
  | "native-module"
  /** The DB was written by a NEWER build than this one. Their data is fine. */
  | "downgrade"
  /** Disk full, or the app-data directory is not writable. */
  | "storage"
  /** Anything unrecognized. */
  | "unknown";

export type DatabaseFailureAdvice = {
  kind: DatabaseFailureKind;
  /** Dialog title. Describes the user's situation, not our internals. */
  title: string;
  /** The one thing they need to know, and what to do about it. */
  headline: string;
  /** Why it probably happened. Parenthetical in the dialog. */
  likelyCause: string;
  /**
   * Label for the primary button. The downgrade case says "newer", not "latest":
   * telling someone who rolled back to install "the latest" is how you get them to
   * reinstall over the data this branch exists to protect.
   */
  primaryActionLabel: string;
};

/**
 * `dlopen`/`.node`/`NODE_MODULE_VERSION` all mean the binding did not load. The
 * ABI-mismatch text is the one we have actually seen in the wild:
 * "was compiled against a different Node.js version using NODE_MODULE_VERSION 141.
 *  This version of Node.js requires NODE_MODULE_VERSION 148."
 */
const NATIVE_MODULE = /NODE_MODULE_VERSION|was compiled against|\.node['"\s]|dlopen|invalid ELF|not a valid Win32 application|Symbol not found|image not found|better[_-]sqlite3/i;

/** Space, permissions, or a path we cannot open at all. */
const STORAGE = /ENOSPC|EACCES|EPERM|EROFS|EMFILE|ENOENT|SQLITE_CANTOPEN|unable to open database file|disk I\/O error|readonly database|attempt to write a readonly/i;

export function describeDatabaseInitFailure(
  error: unknown,
): DatabaseFailureAdvice {
  // Checked by CLASS first, and before the message patterns: this is the one case
  // whose advice is the opposite of the others, and its message happens to mention
  // corruption ("re-applying SQL would corrupt DB"), which a text-first classifier
  // would happily read as a reason to wipe.
  if (error instanceof UnknownDrizzleMigrationHashError) {
    return {
      kind: "downgrade",
      title: "Atlarix can't start",
      headline:
        "Your data was created by a newer version of Atlarix than this one. Installing that newer version again will open it. Nothing is damaged, and nothing needs deleting.",
      likelyCause:
        "Usually a downgrade — an older installer run over a newer one, or a rollback.",
      primaryActionLabel: "Get the newer version",
    };
  }

  const message = error instanceof Error ? error.message : String(error ?? "");

  if (NATIVE_MODULE.test(message)) {
    return {
      kind: "native-module",
      title: "Atlarix can't start",
      headline:
        "The database component doesn't match this version of Atlarix. Reinstalling fixes it — restarting will not.",
      likelyCause:
        "Likely a partial update, or security software quarantining a file inside the app.",
      primaryActionLabel: "Download latest",
    };
  }

  if (STORAGE.test(message)) {
    return {
      kind: "storage",
      title: "Atlarix can't start",
      headline:
        "Atlarix couldn't open its data folder. Check that the disk isn't full and that the folder is writable, then try again.",
      likelyCause:
        "Usually a full disk, or a permissions change on the application-data folder.",
      primaryActionLabel: "Download latest",
    };
  }

  return {
    kind: "unknown",
    title: "Atlarix can't start",
    headline:
      "Atlarix couldn't open its database, and restarting won't change that — it already retried automatically. The details below, and the logs, are what support needs.",
    likelyCause:
      "No recognized cause. The error text below is the useful part.",
    primaryActionLabel: "Download latest",
  };
}
