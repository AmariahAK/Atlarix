/**
 * Tips for the terminal app: the app's tips (src/lib/i18n/locales/en-us/tips.json)
 * rewritten for keys and commands that exist HERE, plus the terminal's own.
 * A tip must never name something the CLI doesn't do (the app's rule, in
 * src/lib/composer-tips.ts), so voice and Settings → Integrations are out and
 * /mcp is in.
 *
 * Timing is the terminal's: one tip under the working line for the length of a
 * turn (there is nothing else to read then) and one on the welcome screen.
 * Each holds still: it is picked by a key, never by a timer.
 */

export interface Tip {
  /** The key or command, drawn in the accent. */
  keys?: string;
  text: string;
}

export const TIPS: Tip[] = [
  { keys: "shift+tab", text: "switches Build, Explore, Plan, Debug and Review" },
  { keys: "ctrl+y", text: "switches the mode too, where the terminal takes shift+tab (VS Code's Tab Moves Focus)" },
  { keys: "ctrl+o", text: "opens up thinking, tool output and sub-agents' calls" },
  { keys: "enter", text: "while Atlarix works steers the turn; tab queues for after it" },
  { keys: "esc esc", text: "on an empty box goes back to an earlier message, and its file changes" },
  { keys: "↓", text: "in an empty box shows background tasks and sub-agents as they run" },
  { keys: "/btw", text: "asks a side question without interrupting the turn" },
  { keys: "@", text: "points at a file; paste or drop screenshots straight into the box" },
  { keys: "!", text: "runs a command yourself; Atlarix sees it and its output next turn" },
  { keys: "ctrl+t", text: "turns deep thinking on and off" },
  { keys: "shift+enter", text: "adds a line; in Apple's Terminal use ctrl+j, or type \\ then enter" },
  { keys: "/model", text: "switches models; ctrl+a in it connects your own API key" },
  { keys: "/resume", text: "picks up an earlier session, including ones from the app" },
  { keys: "/plan", text: "shows this session's plan, and plans from earlier sessions" },
  { keys: "/automations", text: "puts recurring work on a schedule; it runs even when the app is closed" },
  { keys: "/mcp", text: "connects MCP servers to give Atlarix your own tools" },
  { keys: "/compact", text: "frees up context when a long session fills it" },
  { keys: "/notifications", text: "turns off the alert when a turn ends while you're in another window" },
  { keys: "/editor", text: "opens this chat in VS Code, Cursor or Kiro, in the Atlarix extension" },
  { keys: "/handoff", text: "carries this chat on in the Atlarix app — same session, both places" },
  { keys: "/recap", text: "sums up where this session stands; /recap off stops the automatic one" },
  { keys: "/status", text: "shows your account, credit and this session's usage; /billing tops up" },
  { text: "Doing a lot of work? Ask Atlarix to remember the key things, so the next session picks up where you left off." },
  { text: "Ask about something from earlier in this session — Atlarix can search the transcript, even after compacting." },
  { text: "Drop a markdown file in .atlarix/skills/ to teach Atlarix a repeatable job — or ask it to write one." },
  { text: "Hand independent work to sub-agents and let them run in parallel." },
];

/**
 * A stable pick for `key` (a session id + turn number): same key, same tip.
 * `skip` leaves out tips by their keys, where they would be beside the point.
 */
export function pickTip(key: string, skip: readonly string[] = []): Tip {
  const pool = skip.length ? TIPS.filter((t) => !t.keys || !skip.includes(t.keys)) : TIPS;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return pool[(h >>> 0) % pool.length]!;
}
