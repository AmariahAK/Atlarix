/**
 * The task card above the conversation: its title, this chat's tokens (and how
 * many came from cache), what it cost on your keys, how full the context is,
 * and the plan, ticking off as it is built, with "Build it" when it's ready.
 */
import { renderMarkdown } from "../../../extension/src/panel/markdown";
import { post } from "../rpc";
import { state } from "../state";
import { button, el, icon, tokens } from "../ui";

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

export function renderTask(): void {
  taskCard.textContent = "";
  const u = state.usage;
  const started = u.tokens > 0 || !!plan || state.title !== "New chat";
  taskCard.classList.toggle("hidden", !started);
  if (!started) return;

  const head = el("div", "task__head");
  head.append(el("span", "task__title", state.title));
  const copy = button("", "icon small", () => post({ type: "copy", text: state.title }), "Copy the task's title");
  copy.innerHTML = icon("copy", 13);
  const compact = button("", "icon small", () => window.dispatchEvent(new CustomEvent("atlarix-send", { detail: "/compact" })), "Compact: summarise to free up context");
  compact.innerHTML = icon("compact", 13);
  head.append(copy, compact);
  taskCard.append(head);

  if (u.tokens > 0 || u.cost > 0) {
    const stats = el("div", "task__stats");
    stats.append(el("span", "", `${tokens(u.tokens)} tokens`));
    if (u.cachedTokens > 0) stats.append(el("span", "", `${tokens(u.cachedTokens)} from cache`));
    if (u.cost > 0) stats.append(el("span", "task__cost", `$${u.cost.toFixed(u.cost < 1 ? 3 : 2)}`));
    taskCard.append(stats);
  }
  if (u.size > 0) {
    const pct = Math.min(100, Math.round((u.used / u.size) * 100));
    const ctx = el("div", "task__ctx");
    const bar = el("span", "bar");
    const fill = el("span", `bar__fill${pct > 85 ? " hot" : ""}`);
    fill.style.width = `${pct}%`;
    bar.append(fill);
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `Context ${pct}% full`);
    ctx.append(el("span", "", "Context"), bar, el("span", "mono", `${tokens(u.used)} / ${tokens(u.size)}`));
    taskCard.append(ctx);
  }

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
