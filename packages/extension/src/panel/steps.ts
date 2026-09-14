/**
 * One line describing what the agent did, for the collapsed activity card.
 *
 * THE PROBLEM THIS SOLVES. A turn that reads two pages and fills six fields
 * produced fourteen stacked cards, and the answer — the thing the person asked
 * for — was pushed off the bottom of a 320px panel. The work was legible and the
 * result was not, which is exactly backwards.
 *
 * So ADJACENT thinking and tool steps collapse into one card, the way Claude's
 * own web UI does it ("Ran 4 commands, read a file, shared files · 3 notes").
 * Nothing is removed: open the card and the per-step cards are all still there,
 * each still expandable to its full output.
 *
 * ADJACENT, and that word is the whole rule. The model's rhythm is the model's:
 * some narrate between every call, some think once and run six tools, and the
 * same model does both on different questions. So the grouping follows what
 * actually happened rather than imposing a shape — a run of thinking and tools
 * becomes one card, prose ends the run, and a step that stands alone STAYS
 * alone rather than being wrapped in a card that adds a click and says nothing.
 *
 * GROUPED BY WHAT IT MEANT, NOT BY TOOL NAME. "read_page ×2, find_on_page ×1" is
 * the transcript restated; "Read 3 pages" is what happened. The grouping is also
 * why this is a module with tests rather than a template literal — plural rules,
 * an ordering that has to be stable, and a cap on how much detail a one-line
 * summary can carry are three things that are easy to get subtly wrong and
 * impossible to notice.
 */

/** What one entry in the card represents. */
export type Step =
  | { kind: "thinking" }
  | { kind: "tool"; name: string }
  | { kind: "approval" };

/**
 * Tool name → the verb a person would use, singular and plural.
 *
 * An unknown tool falls back to a COUNT, never a raw identifier — the failure
 * mode of the desktop's `LABELS` map, recorded as the "Runned <tool>" trap.
 *
 * EVERY TOOL IN `TOOL_NAMES` NEEDS AN ENTRY, and `steps.test.ts` asserts it.
 * Four were missing when the MCP tools shipped — `read_note`, `forget_note`,
 * `list_available_mcps`, `mcp_call` — and the visible result was a card reading
 * "1 step, 1 step", because two different unlabelled tools each rendered their
 * own fallback phrase. Both halves are fixed: the entries exist, and the
 * fallback now aggregates so a fifth omission cannot produce that line again.
 */
const VERBS: Record<string, { one: string; many: (n: number) => string }> = {
  read_page: { one: "Read a page", many: (n) => `Read ${n} pages` },
  find_on_page: { one: "Searched a page", many: (n) => `Searched ${n} pages` },
  click: { one: "Clicked once", many: (n) => `Clicked ${n} times` },
  fill: { one: "Filled a field", many: (n) => `Filled ${n} fields` },
  press_key: { one: "Pressed a key", many: (n) => `Pressed ${n} keys` },
  hover: { one: "Hovered", many: (n) => `Hovered ${n} times` },
  scroll: { one: "Scrolled", many: (n) => `Scrolled ${n} times` },
  list_tabs: { one: "Listed the tabs", many: () => "Listed the tabs" },
  open_tab: { one: "Opened a tab", many: (n) => `Opened ${n} tabs` },
  close_tab: { one: "Closed a tab", many: (n) => `Closed ${n} tabs` },
  remember: { one: "Saved a note", many: (n) => `Saved ${n} notes` },
  read_note: { one: "Read a note", many: (n) => `Read ${n} notes` },
  forget_note: { one: "Deleted a note", many: (n) => `Deleted ${n} notes` },
  read_attachment: {
    one: "Read an attachment",
    many: (n) => `Read ${n} pages of attachments`,
  },
  list_available_mcps: {
    one: "Checked your connectors",
    many: () => "Checked your connectors",
  },
  mcp_call: {
    one: "Used a connector",
    many: (n) => `Used connectors ${n} times`,
  },
  recall: { one: "Looked back", many: (n) => `Looked back ${n} times` },
  web_search: { one: "Searched the web", many: (n) => `Searched the web ${n} times` },
  ask_user: { one: "Asked you", many: (n) => `Asked you ${n} times` },
};

/**
 * How many distinct verbs the line names before it gives up and counts.
 *
 * Three is what fits a 320px panel at this font size. Beyond that the line wraps
 * to three rows and stops being a summary.
 */
const MAX_PHRASES = 3;

/**
 * The collapsed card's line.
 *
 * `running` changes the tense and the emphasis: while a turn is live the person
 * wants to know something is happening, so the count leads. Afterwards they want
 * to know what happened, so the verbs lead.
 */
export function summariseSteps(
  steps: Step[],
  opts: { running?: boolean } = {},
): string {
  const tools = steps.filter(
    (s): s is { kind: "tool"; name: string } => s.kind === "tool",
  );
  const thoughts = steps.filter((s) => s.kind === "thinking").length;

  if (steps.length === 0) return opts.running ? "Working…" : "No steps";

  // Insertion-ordered, so the line reads in the order things happened rather
  // than in whatever order a Record decides to enumerate.
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }

  const phrases: string[] = [];
  let remaining = 0;
  // Tools with no verb are COUNTED TOGETHER, not phrased one by one. Two
  // unlabelled tools used to render "1 step, 1 step", which reads as a bug
  // because it is one.
  let unnamed = 0;
  for (const [name, n] of counts) {
    const verb = VERBS[name];
    if (!verb) {
      unnamed += n;
      continue;
    }
    if (phrases.length >= MAX_PHRASES) {
      remaining += n;
      continue;
    }
    phrases.push(n === 1 ? verb.one : verb.many(n));
  }
  if (unnamed > 0) {
    if (phrases.length >= MAX_PHRASES) remaining += unnamed;
    else phrases.push(`${unnamed} step${unnamed === 1 ? "" : "s"}`);
  }
  if (remaining > 0) {
    phrases.push(`${remaining} more step${remaining === 1 ? "" : "s"}`);
  }

  // Thinking is an aside, not an action — it goes after the separator, the way
  // Claude's own line puts "· 3 notes" after what it did.
  // An aside, after the separator — the shape Claude's own line uses with
  // "· 3 notes". Thinking is not an action and should not crowd out the verbs.
  const aside =
    thoughts > 0 ? ` · thought ${thoughts === 1 ? "once" : `${thoughts} times`}` : "";

  if (opts.running) {
    return phrases.length > 0 ? `Working… · ${phrases.join(", ")}` : "Working…";
  }
  if (phrases.length === 0) {
    return thoughts > 0
      ? `Thought for a moment${thoughts > 1 ? ` · ${thoughts} times` : ""}`
      : "No steps";
  }
  return `${phrases.join(", ")}${aside}`;
}
