/**
 * A Plan-mode reply that IS a plan, written inline instead of through the plan
 * tool. Models do this ("write a very short plan (3 steps)" came back as a
 * numbered list in the reply), and then there is no plan card and no Build it
 * (QA #43b). Such a reply is saved as the session's plan when the turn ends.
 *
 * Deliberately narrow: at least two steps (a numbered list or checkboxes), some
 * substance, and not a reply that ends by asking something — a clarifying
 * question with options is not a plan.
 *
 * Only the plan is kept: from its heading (or the line introducing the steps)
 * through its last step. What the reply said around it — command output before,
 * a closing note after — is not the plan (QA #53).
 */
const STEP = /^\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+\S/;

export function inlinePlan(reply: string): { title: string; content: string } | null {
  const text = reply.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (text.length < 80) return null;
  const lines = text.split("\n");
  const steps = lines.map((l, i) => (STEP.test(l) ? i : -1)).filter((i) => i >= 0);
  if (steps.length < 2) return null;
  const last = lines.map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (last.endsWith("?")) return null;

  const first = steps[0]!;
  // The last step and its own continuation lines (indented, or nested items).
  let end = steps.at(-1)!;
  while (end + 1 < lines.length && /^\s+\S/.test(lines[end + 1]!)) end += 1;

  // Where the plan starts: its heading, else the line that introduces the steps.
  const heading = [...lines.slice(0, first).entries()].reverse().find(([, l]) => /^#{1,3}\s+\S/.test(l) || /^\*\*.+\*\*:?\s*$/.test(l.trim()));
  const intro = [...lines.slice(0, first).entries()].reverse().find(([, l]) => l.trim());
  const start = heading ? heading[0] : intro && intro[1].trim().length <= 100 ? intro[0] : first;

  const plain = (s: string) => s.replace(/^#{1,3}\s+/, "").replace(/[*_`]/g, "").replace(/:\s*$/, "").trim();
  const generic = (s: string) => /^(?:(?:here(?:['’]s| is)\s+)?(?:a|the|my)?\s*(?:short|quick|brief)?\s*plan)$/i.test(s);
  let title = heading ? plain(heading[1]) : intro && start === intro[0] ? plain(intro[1]) : "";
  // "Here's a short plan to add a --version flag" → "Add a --version flag".
  title = title.replace(/^(?:here(?:['’]s| is)\s+)?(?:a|the|my)\s+(?:(?:short|quick|brief)\s+)?plan\s+(?:to|for)\s+/i, "");
  if (!title || generic(title)) title = plain(lines[first]!.replace(/^\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+/, "")).replace(/\.$/, "");
  title = title.charAt(0).toUpperCase() + title.slice(1);

  return { title: title.slice(0, 80), content: lines.slice(start, end + 1).join("\n").trim() };
}
