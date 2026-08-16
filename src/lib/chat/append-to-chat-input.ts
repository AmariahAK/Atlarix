/**
 * Add something to whatever the user has already typed, without eating it.
 *
 * "Send to Atlarix" replaces the completion gate for the cases where something
 * genuinely IS broken. That only works if the user can queue several things —
 * a failed request, then a console error, then their own sentence — so this
 * appends behind a separator rather than overwriting, and never leaves a
 * dangling separator when one side is empty.
 */
export function appendToChatInput(existing: string, addition: string): string {
  const before = (existing ?? "").trim();
  const next = (addition ?? "").trim();
  if (!next) return existing ?? "";
  if (!before) return next;
  return `${before}\n\n---\n${next}`;
}
