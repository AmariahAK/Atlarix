/**
 * What is still running in this chat, above the message box: a chip ("2
 * running") while anything is, and the list it opens — sub-agents and the
 * commands the agent started in the background — each with its time, a
 * stalled badge, its live output, Ask about this and Stop. The desktop app's
 * background-tasks chip; the transcript's sub-agent panels are the narration,
 * this is the control.
 *
 * The agent says when the set changes (`_atlarix/tasks_changed`); the list is
 * read only while open, and one task's output is polled only while expanded.
 */
import { rpc } from "../rpc";
import { state } from "../state";
import { button, el, tokens } from "../ui";
import { addContext, focusInput } from "./composer";

interface TaskRow {
  id: string;
  kind: "agent" | "command";
  label: string;
  elapsedMs: number;
  stalled: boolean;
  tokens: number | null;
  progress: string | null;
  tools: number;
  canStop: boolean;
}

export const tasksBar = el("div", "tasks hidden");
const chip = button("", "tasks__chip", () => toggle());
chip.setAttribute("aria-expanded", "false");
const panel = el("section", "tasks__panel hidden");
panel.setAttribute("aria-label", "Running in this chat");
tasksBar.append(panel, chip);

let count = 0;
let rows: TaskRow[] = [];
let readAt = 0;
let expanded: string | null = null;
let tail = "";
let poll: ReturnType<typeof setInterval> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function isOpen(): boolean {
  return !panel.classList.contains("hidden");
}

function drawChip(): void {
  tasksBar.classList.toggle("hidden", count === 0 && !isOpen());
  chip.textContent = "";
  chip.append(el("span", "tasks__dot spin", "◌"), el("span", "", `${count} running`));
  chip.title = "What is still running in this chat";
}

async function refresh(): Promise<void> {
  if (!state.sessionId) return;
  const r = await rpc<{ tasks?: TaskRow[] }>("_atlarix/tasks", { sessionId: state.sessionId, action: "list" }).catch(() => ({ tasks: [] }));
  rows = r.tasks ?? [];
  readAt = Date.now();
  count = rows.length;
  if (expanded && !rows.some((t) => t.id === expanded)) setExpanded(null);
  drawChip();
  drawPanel();
}

function drawPanel(): void {
  if (!isOpen()) return;
  panel.textContent = "";
  const head = el("div", "tasks__head");
  head.append(el("strong", "", "Background tasks"), button("Close", "link small", () => toggle(false)));
  panel.append(head);
  if (!rows.length) {
    panel.append(el("div", "muted tasks__empty", "Nothing running."));
    return;
  }
  for (const [kind, name] of [["agent", "Sub-agents"], ["command", "Commands"]] as const) {
    const group = rows.filter((t) => t.kind === kind);
    if (!group.length) continue;
    panel.append(el("div", "tasks__group", name));
    for (const t of group) panel.append(drawRow(t));
  }
}

function drawRow(t: TaskRow): HTMLElement {
  const row = el("div", `task-row${t.stalled ? " stalled" : ""}`);
  const head = button("", "task-row__head", () => setExpanded(expanded === t.id ? null : t.id));
  head.setAttribute("aria-expanded", String(expanded === t.id));
  const time = el("span", "task-row__time", clock(t.elapsedMs));
  time.dataset.base = String(t.elapsedMs);
  head.append(
    el("span", `tasks__dot spin${t.stalled ? " warn" : ""}`, "◌"),
    el("span", `task-row__label${t.kind === "command" ? " mono" : ""}`, t.label.split("\n")[0] ?? t.label),
  );
  if (t.stalled) head.append(el("span", "badge stalled", "no output lately"));
  else if (t.kind === "agent" && t.tokens) head.append(el("span", "task-row__tokens", tokens(t.tokens)));
  head.append(time);
  row.append(head);
  if (expanded !== t.id) return row;
  const out = el("pre", "task-row__tail", tail || (t.kind === "agent" ? (t.progress ?? "Working…") : "No output yet."));
  const acts = el("div", "task-row__actions");
  acts.append(
    button("Ask about this", "small", () => {
      // The output goes in as context; the question is yours to write.
      addContext({ path: "", label: `${t.kind === "command" ? "Output" : "Sub-agent"}: ${shortLabel(t.label)}`, text: tail || t.label });
      toggle(false);
      focusInput();
    }),
  );
  if (t.canStop) {
    acts.append(
      button("Stop", "small deny", async () => {
        await rpc("_atlarix/tasks", { sessionId: state.sessionId, action: "stop", id: t.id }).catch(() => null);
        setExpanded(null);
        void refresh();
      }),
    );
  } else {
    acts.append(el("span", "muted small", "Part of the running turn: Stop ends it."));
  }
  row.append(out, acts);
  return row;
}

function shortLabel(label: string): string {
  const first = label.split("\n")[0] ?? label;
  return first.length > 48 ? `${first.slice(0, 47)}…` : first;
}

async function readTail(): Promise<void> {
  if (!expanded || !state.sessionId) return;
  const r: { text?: string; gone?: boolean } = await rpc<{ text?: string; gone?: boolean }>("_atlarix/tasks", {
    sessionId: state.sessionId,
    action: "output",
    id: expanded,
  }).catch(() => ({ text: "" }));
  if (r.gone) return void refresh();
  const lines = (r.text ?? "").trimEnd().split("\n");
  tail = lines.slice(-40).join("\n");
  const pre = panel.querySelector<HTMLElement>(".task-row__tail");
  if (pre && tail) {
    pre.textContent = tail;
    pre.scrollTop = pre.scrollHeight;
  }
}

function setExpanded(id: string | null): void {
  expanded = id;
  tail = "";
  if (poll) clearInterval(poll);
  poll = null;
  drawPanel();
  if (id) {
    void readTail();
    poll = setInterval(() => void readTail(), 2000);
  }
}

function tick(): void {
  const since = Date.now() - readAt;
  for (const t of panel.querySelectorAll<HTMLElement>(".task-row__time[data-base]")) {
    t.textContent = clock(Number(t.dataset.base) + since);
  }
}

function toggle(open = !isOpen()): void {
  panel.classList.toggle("hidden", !open);
  chip.setAttribute("aria-expanded", String(open));
  if (open) {
    void refresh();
    ticker ??= setInterval(tick, 1000);
  } else {
    setExpanded(null);
    if (ticker) clearInterval(ticker);
    ticker = null;
  }
  drawChip();
}

/** The agent said what is running changed. */
export function tasksChanged(n: number): void {
  count = n;
  drawChip();
  if (isOpen()) void refresh();
}

/** A different chat: start from what is running in it. */
export function resetTasks(): void {
  toggle(false);
  rows = [];
  count = 0;
  drawChip();
  void refresh();
}
