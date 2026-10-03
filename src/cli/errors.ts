/**
 * What a person sees when the CLI stops on an error: one plain line, and the
 * stack only when asked for (`--debug` or ATLARIX_DEBUG=1). Printing the raw
 * error from a compiled binary shows Bun's source excerpt of the bundled file
 * and `/$bunfs/root/…` frames, which say nothing to the person reading them.
 */
import {
  DatabaseInUseForUpgradeError,
  DatabaseNewerThanClientError,
} from "@/db/migrate_atlarix";

export function isDebug(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--debug") || process.env.ATLARIX_DEBUG === "1";
}

/** The sentence to show. Known failures carry their own, already written for people. */
export function friendlyMessage(err: unknown): string {
  if (err instanceof DatabaseNewerThanClientError || err instanceof DatabaseInUseForUpgradeError) {
    return err.message;
  }
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** The full text to print for a fatal error. */
export function formatFatal(err: unknown, debug = isDebug()): string {
  const line = `atlarix: ${friendlyMessage(err)}`;
  if (!debug) return `${line}\n(run with --debug for details)`;
  const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
  return line + stack;
}
