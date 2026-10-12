/**
 * The plan card above the conversation, ticking off as it is built, with
 * "Build it" when it's ready.
 */
import { renderMarkdown } from "../../../extension/src/panel/markdown";
import { state } from "../state";
import { button, el } from "../ui";

export const taskCard = el("section", "task hidden");
taskCard.setAttribute("aria-label", "This task");

let plan: { entries: Array<{ content: string; status: string }>; doc?: { title?: string; content?: string; buildable?: boolean; status?: string } } | null = null;
let planFolded = false;

const STEP_MARK: Record<string, string> = { pending: "☐", in_progress: "◐", completed: "☑" };

/** Whether the plan document says more than its own checklist (else "Whole plan" just repeats it). */
function addsToSteps(content: string): boolean {
  const rest = content
    .split("\n")
    .filter((l) => !/^\s*(#|[-*+]\s+\[|\d+[.)]\s|[-*+]\s|$)/.test(l))
    .join(" ")
    .trim();
  return rest.length > 80;
}

export function setPlan(p: { entries: Array<{ content: string; status: string }>; _meta?: unknown }): void {
  const doc = (p._meta as { atlarix?: { plan?: NonNullable<typeof plan>["doc"] } } | undefined)?.atlarix?.plan;
  plan = !p.entries.length && !doc ? null : { entries: p.entries, doc };
  renderTask();
}

export function clearTask(): void {
  plan = null;
  renderTask();
}

/**
 * The plan, over the conversation, while there is one. How full the context is
 * (and the chat's tokens and cost) is the ring beside the model under the box
 * (composer.ts), as in the app: one quiet mark, not a bar across the top.
 */
export function renderTask(): void {
  taskCard.textContent = "";
  taskCard.classList.toggle("hidden", !plan);
  if (plan) taskCard.append(planSection(plan));
}

function planSection(p: NonNullable<typeof plan>): HTMLElement {
  const sec = el("div", "task__plan");
  const done = p.entries.filter((e) => e.status === "completed").length;
  const head = el("div", "task__plan-head");
  const title = button(`${planFolded ? "▸" : "▾"} ${p.doc?.title ?? "Plan"}`, "plan__title", () => {
    planFolded = !planFolded;
    renderTask();
  }, planFolded ? "Show the steps" : "Hide the steps");
  head.append(title);
  if (p.doc?.buildable) {
    const build = button("Build it", "primary small", () => window.dispatchEvent(new CustomEvent("atlarix-build")));
    build.toggleAttribute("disabled", state.busy);
    head.append(build);
  } else if (p.entries.length) {
    const all = done === p.entries.length || p.doc?.status === "built";
    const label = all ? "Built" : done > 0 ? `${done} of ${p.entries.length}` : state.busy ? "Building…" : "";
    if (label) head.append(el("span", `plan__progress${all ? " done" : ""}`, label));
  }
  sec.append(head);
  if (planFolded) return sec;
  const list = el("ol", "plan__steps");
  for (const e of p.entries) {
    const li = el("li", `pstep ${e.status}`);
    li.append(el("span", "pstep__mark", STEP_MARK[e.status] ?? "☐"));
    const text = el("span", "pstep__text");
    renderMarkdown(text, e.content);
    li.append(text);
    list.append(li);
  }
  sec.append(list);
  if (p.doc?.content && addsToSteps(p.doc.content)) {
    const more = el("details", "plan__doc");
    more.append(el("summary", "", "Whole plan"));
    const body = el("div", "body");
    renderMarkdown(body, p.doc.content);
    more.append(body);
    sec.append(more);
  }
  return sec;
}
