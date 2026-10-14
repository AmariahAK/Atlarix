/**
 * The one line every surface shows when a revert left files alone because
 * they changed after the turn (owner: no random reverts). Same words in the
 * app, the CLI and the editor.
 */
export function keptFilesLine(kept: readonly string[]): string | null {
  if (kept.length === 0) return null;
  const names = kept.map((f) => f.split("/").pop() || f);
  const shown =
    names.length <= 3
      ? names.join(", ")
      : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return `Kept ${shown} (changed since)`;
}
