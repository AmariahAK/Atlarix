/**
 * Workspace (and global) slash commands: `/name` expands before the main chat stream.
 */

export interface CustomCommandRow {
  id: number;
  name: string;
  promptTemplate: string;
  modeOverride: string | null;
  workspaceId: number | null;
}

export function parseCommandFromMessage(
  text: string,
  commands: { name: string }[],
): { name: string; rest: string } | null {
  const t = text.trimStart();
  if (!t.startsWith("/")) return null;
  const space = t.indexOf(" ");
  const rawName = (space < 0 ? t.slice(1) : t.slice(1, space)).trim();
  if (!rawName) return null;
  const lower = rawName.toLowerCase();
  const cmd = commands.find((c) => c.name.toLowerCase() === lower);
  if (!cmd) return null;
  const rest = space < 0 ? "" : t.slice(space).trim();
  return { name: cmd.name, rest };
}

/** Replace `{{input}}` or `{input}` with the user text after `/name`. */
export function buildCommandPrompt(template: string, userRest: string): string {
  return template
    .replace(/\{\{\s*input\s*\}\}/gi, userRest)
    .replace(/\{input\}/gi, userRest);
}
