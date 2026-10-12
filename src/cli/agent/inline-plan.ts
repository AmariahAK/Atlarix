/**
 * A Plan-mode reply that IS a plan, written inline instead of through the plan
 * tool. Models do this ("write a very short plan (3 steps)" came back as a
 * numbered list in the reply), and then there is no plan card and no Build it
 * (QA #43b). Such a reply is saved as the session's plan when the turn ends.
 *
 * Deliberately narrow: at least two steps (a numbered list or checkboxes), some
 * substance, and not a reply that ends by asking something — a clarifying
 * question with options is not a plan.
 */
export function inlinePlan(reply: string): { title: string; content: string } | null {
  const text = reply.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (text.length < 80) return null;
  const steps = text.split("\n").filter((l) => /^\s*(?:\d+[.)]|[-*]\s+\[[ xX]\])\s+\S/.test(l));
  if (steps.length < 2) return null;
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (last.endsWith("?")) return null;
  const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.replace(/[*_`]/g, "").trim();
  const bold = /^\*\*(.+?)\*\*:?\s*$/m.exec(text)?.[1]?.trim();
  return { title: (heading || bold || "Plan").slice(0, 80), content: text };
}
