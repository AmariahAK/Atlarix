/**
 * The slash commands. Phase 2 ships the ones whose behaviour exists; the rest of
 * the palette on the canvas (/model, /resume, /export …) arrives with its phase
 * and is listed only once it works — a command that does nothing is worse than
 * one that is missing.
 */
export interface SlashCommand {
  name: string;
  description: string;
  /** "plugin": an installed plugin's command, sent as a message (plugins/commands.ts). */
  group: "session" | "work" | "tools" | "account" | "plugin";
  /** Another name for a command that is listed: works when typed, not shown in lists. */
  alias?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  { name: "/model", description: "Atlarix Auto, a Core model, or one of your own keys", group: "session" },
  { name: "/models", description: "Same as /model", group: "session", alias: true },
  { name: "/mode", description: "Build, Explore, Plan, Debug or Review (shift+tab or ctrl+y cycles)", group: "session" },
  { name: "/new", description: "Start a fresh session in this folder", group: "session" },
  { name: "/rename", description: "Name this session (it's named from your first message until you do)", group: "session" },
  { name: "/resume", description: "Open an earlier session from this folder (the app's too)", group: "session" },
  { name: "/handoff", description: "Continue this session in the Atlarix app (from the app: Continue in terminal)", group: "session" },
  { name: "/undo", description: "Go back to one of your messages: edit and resend it, restoring files (esc esc too)", group: "session" },
  { name: "/compact", description: "Summarise the conversation so far to free up context", group: "session" },
  { name: "/fork", description: "Carry on in a copy of this session; the original stays as it is (/fork <name> names it)", group: "session" },
  { name: "/effort", description: "How hard the model thinks: its own levels, as it lists them (ctrl+t: top or default)", group: "session" },
  { name: "/context", description: "How much of the context window to use before compacting: 256k, 512k or full", group: "session" },
  { name: "/plan", description: "This session's plan: show it, or /plan share to save it as a page", group: "session" },
  { name: "/build", description: "Build the plan that is ready", group: "session" },
  { name: "/export", description: "Save this session as Markdown (--json, --sanitize, a file name)", group: "session" },
  { name: "/import", description: "Bring in a session: --from claude|codex|opencode, or a file", group: "session" },
  { name: "/relics", description: "Pages Atlarix made to share: open, copy the link, share, delete", group: "work" },
  { name: "/tasks", description: "Sub-agents and background commands, live (↓ in an empty box)", group: "work" },
  { name: "/agents", description: "Same as /tasks", group: "work", alias: true },
  { name: "/btw", description: "Ask a side question without interrupting (not saved)", group: "work" },
  { name: "/editor", description: "Open this chat in VS Code, Cursor or Kiro (the Atlarix extension): /editor cursor", group: "session" },
  { name: "/recap", description: "One line on where this session stands; /recap on|off for the automatic one", group: "work" },
  { name: "/automations", description: "Scheduled and triggered tasks for this folder", group: "work" },
  { name: "/mcp", description: "MCP servers for this folder: turn on/off, add, test", group: "tools" },
  { name: "/silks", description: "Silks you installed: add, update, turn on/off", group: "tools" },
  { name: "/augments", description: "Same as /silks", group: "tools", alias: true },
  { name: "/plugins", description: "Same as /silks", group: "tools", alias: true },
  { name: "/mods", description: "Panes your mods opened", group: "tools" },
  { name: "/chrome", description: "The Chrome extension: connected, or how to connect it", group: "tools" },
  { name: "/computer", description: "Let this model see your screen and use the mouse and keyboard: /computer on|off", group: "tools" },
  { name: "/permissions", description: "What Atlarix may do here without asking", group: "tools" },
  { name: "/connect", description: "Connect a provider (your own API key), Chrome or an MCP server", group: "account" },
  { name: "/billing", description: "Get Pro, or add credit and pay as you go", group: "account" },
  { name: "/upgrade", description: "Same as /billing", group: "account", alias: true },
  { name: "/notifications", description: "Ring the bell when a turn ends or needs you, and notify while the terminal isn't focused (on/off)", group: "account" },
  { name: "/analytics", description: "Usage analytics: on or off (shared with the app)", group: "account" },
  { name: "/feedback", description: "Tell us what to improve; /feedback 1|2|3 rates this session too", group: "account" },
  { name: "/status", description: "Account, balance, model, usage, Chrome, MCP", group: "account" },
  { name: "/usage", description: "Usage: activity, credits, tokens, MCP and skills, Auto's picks", group: "account" },
  { name: "/stats", description: "Same as /usage", group: "account", alias: true },
  { name: "/login", description: "Sign in to Atlarix", group: "account" },
  { name: "/logout", description: "Sign out of the CLI", group: "account" },
  { name: "/help", description: "Keys and commands", group: "session" },
  { name: "/exit", description: "Leave Atlarix", group: "session" },
  { name: "/quit", description: "Same as /exit", group: "session", alias: true },
];

/**
 * A typed line that is a command: its name and what follows it
 * (`/export notes.md --sanitize` → "/export", "notes.md --sanitize").
 */
export function parseCommandLine(line: string): { name: string; rest: string } | null {
  const m = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!m || !COMMANDS.some((c) => c.name === m[1])) return null;
  return { name: m[1]!, rest: (m[2] ?? "").trim() };
}

/** Commands matching what has been typed after "/", best first. */
export function matchCommands(typed: string, installed: SlashCommand[] = []): SlashCommand[] {
  const q = typed.trim().toLowerCase();
  // Once arguments are being typed, the palette has done its job.
  if (!q.startsWith("/") || /\s/.test(q)) return [];
  const needle = q.slice(1);
  // A built-in of the same name wins, as it does when run.
  const all = COMMANDS.concat(installed.filter((p) => !COMMANDS.some((c) => c.name === p.name)));
  // The exact name first: "/mode" + enter ran /model, the first prefix match.
  // Aliases only when typed in full.
  const exact = all.filter((c) => c.name === q);
  const listed = all.filter((c) => !c.alias && c.name !== q);
  return exact.concat(listed.filter((c) => c.name.slice(1).startsWith(needle))).concat(
    listed.filter((c) => !c.name.slice(1).startsWith(needle) && c.name.includes(needle)),
  );
}
