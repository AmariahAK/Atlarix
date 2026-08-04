/**
 * A `cd` inside a run_command lasts exactly as long as that one shell.
 *
 * Nothing told the model that. So a turn that prefixed `cd /some/other/dir &&`
 * carried on believing it had moved, and every relative path afterwards resolved
 * somewhere else — in one real run, a model went looking for the user's project
 * files inside the installed application bundle and only recovered by globbing
 * the whole disk. Claude Code hit the identical failure and fixed it the same
 * way: say plainly that the working directory did not change.
 *
 * Deliberately only fires when a `cd` is actually present — an unconditional
 * note would be noise on every command, and noise is how real notices get
 * skimmed past.
 */

/** `cd` at the start of the command or of any `&&` / `;` / `|` segment. */
const CD_SEGMENT = /(?:^|[;&|])\s*(?:cd|chdir|pushd|popd)\b/;

export function commandChangesDirectory(command: string): boolean {
  return CD_SEGMENT.test(command || "");
}

/**
 * Fields to merge into a run_command tool result. Empty when the command has no
 * `cd`, so callers can spread it unconditionally.
 */
export function cwdNoteForCommand(
  command: string,
  workingDirectory?: string,
): { cwdNote?: string } {
  if (!commandChangesDirectory(command)) return {};
  const where = workingDirectory?.trim();
  return {
    cwdNote:
      `This command contained a directory change, which applied only inside that shell and has already ended. ` +
      `Your working directory is unchanged${where && where !== "." ? ` — still ${where}` : ""}. ` +
      `The next command starts there again, so use the \`cwd\` parameter (or absolute paths) rather than a \`cd\` prefix.`,
  };
}
