/**
 * Sub-agents in the conversation, as the desktop app draws them: one panel per
 * round (the sub-agents one reply started), "Sub-agents · 2/3 running", a row
 * per agent with what it is doing, its time and tokens, and its own calls and
 * report one click away.
 *
 * Drawn from `_meta.atlarix.subagent` on the `task` call (src/cli/acp/updates.ts).
 * Live rounds stay open; once every agent has settled the panel folds to its
 * one line, because a report is written for the agent, not for you. A round you
 * opened yourself stays open.
 */
import { renderMarkdown } from "../../../extension/src/panel/markdown";
import { button, el, tokens } from "../ui";

export interface SubagentMeta {
  label?: string | null;
  status?: string;
  progress?: string | null;
  tokens?: number | null;
  startedAt?: number | null;
  tools?: Array<{ verb: string; target: string; status: string }>;
  report?: string | null;
}

/** Atlarix's own marks (src/cli/tui/glyphs.ts). */
const MARK: Record<string, string> = { running: "◌", success: "◇", error: "✕", interrupted: "◻" };

type Agent = { id: string; meta: SubagentMeta; row: HTMLElement; open: boolean };
type Round = { el: HTMLElement; head: HTMLButtonElement; body: HTMLElement; agents: Map<string, Agent>; userToggled: boolean; open: boolean };

const rounds = new Map<string, Round>();
let ticker: ReturnType<typeof setInterval> | null = null;

const settled = (s?: string) => s === "success" || s === "error" || s === "interrupted";

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The round a `task` call belongs to: the reply that started it (`<message>:t:task_<n>`). */
function roundKey(toolCallId: string): string {
  return toolCallId.split(":t:")[0] ?? toolCallId;
}

function newRound(key: string): Round {
  const root = el("section", "agents");
  root.setAttribute("aria-label", "Sub-agents");
  const head = button("", "agents__head", () => {
    r.userToggled = true;
    setOpen(r, !r.open);
  });
  const body = el("div", "agents__body");
  root.append(head, body);
  const r: Round = { el: root, head, body, agents: new Map(), userToggled: false, open: true };
  rounds.set(key, r);
  return r;
}

function setOpen(r: Round, open: boolean): void {
  r.open = open;
  r.body.classList.toggle("hidden", !open);
  r.head.setAttribute("aria-expanded", String(open));
}

function phase(m: SubagentMeta): string {
  if (m.status === "error") return "Failed";
  if (settled(m.status)) return `Done${m.tools?.length ? ` · ${m.tools.length} tool${m.tools.length === 1 ? "" : "s"}` : ""}`;
  const last = m.tools?.[m.tools.length - 1];
  const doing = m.progress?.trim() || "Working…";
  return last ? `${doing} · ${last.verb} ${last.target}`.trim() : doing;
}

function drawAgent(a: Agent): void {
  const m = a.meta;
  const status = m.status ?? "running";
  a.row.className = `agent ${status}`;
  a.row.textContent = "";
  const head = button("", "agent__head", () => {
    a.open = !a.open;
    drawAgent(a);
  });
  head.setAttribute("aria-expanded", String(a.open));
  const title = el("span", "agent__title");
  title.append(el("strong", "", m.label?.trim() || "Sub-agent"), el("span", "agent__phase", phase(m)));
  const meta = el("span", "agent__meta");
  const time = el("span", "agent__time");
  if (m.startedAt && !settled(status)) time.dataset.started = String(m.startedAt);
  time.textContent = m.startedAt && !settled(status) ? clock(Date.now() - m.startedAt) : "";
  meta.append(time);
  if (m.tokens) meta.append(el("span", "", `${time.textContent ? " · " : ""}${tokens(m.tokens)}`));
  head.append(el("span", `agent__mark${settled(status) ? "" : " spin"}`, MARK[status] ?? MARK.running), title, meta);
  a.row.append(head);
  if (!a.open) return;
  const body = el("div", "agent__body");
  for (const t of m.tools ?? []) {
    const line = el("div", "agent__tool");
    line.append(el("span", "agent__tool-mark", MARK[t.status] ?? MARK.success), el("span", "", t.target ? `${t.verb} ${t.target}` : t.verb));
    body.append(line);
  }
  if (!m.tools?.length && !settled(status)) body.append(el("div", "muted", "Waiting for its first step…"));
  if (m.report?.trim()) {
    const report = el("div", "agent__report");
    renderMarkdown(report, m.report);
    body.append(report);
  }
  a.row.append(body);
}

function drawHead(r: Round): void {
  const all = [...r.agents.values()];
  const running = all.filter((a) => !settled(a.meta.status)).length;
  const used = all.reduce((n, a) => n + (a.meta.tokens ?? 0), 0);
  r.head.textContent = "";
  r.head.append(
    el("span", `agent__mark${running ? " spin" : ""}`, running ? MARK.running : MARK.success),
    el("span", "agents__summary", running ? `Sub-agents · ${running}/${all.length} running` : `Sub-agents · ${all.length} completed`),
    el("span", "agents__tokens", used ? tokens(used) : ""),
  );
  // Active first, then done, then failed: what is happening stays on top.
  const rank = (a: Agent) => (a.meta.status === "error" ? 2 : settled(a.meta.status) ? 1 : 0);
  for (const a of all.sort((x, y) => rank(x) - rank(y))) r.body.append(a.row);
  if (!running && !r.userToggled && r.open) setOpen(r, false);
}

function tick(): void {
  let live = false;
  for (const t of document.querySelectorAll<HTMLElement>(".agent__time[data-started]")) {
    t.textContent = clock(Date.now() - Number(t.dataset.started));
    live = true;
  }
  if (!live && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Draw or update a sub-agent. Returns the round's element the first time it is
 * created (for the transcript to place), else null.
 */
export function upsertSubagent(toolCallId: string, meta: SubagentMeta): HTMLElement | null {
  const key = roundKey(toolCallId);
  let r = rounds.get(key);
  const created = !r;
  r ??= newRound(key);
  let a = r.agents.get(toolCallId);
  if (!a) {
    a = { id: toolCallId, meta, row: el("div", "agent"), open: false };
    r.agents.set(toolCallId, a);
    // A new agent reopens a round that had folded, unless you closed it.
    if (!r.userToggled) setOpen(r, true);
  }
  a.meta = { ...a.meta, ...meta };
  drawAgent(a);
  drawHead(r);
  if (!settled(meta.status) && !ticker) ticker = setInterval(tick, 1000);
  return created ? r.el : null;
}

export function resetSubagents(): void {
  rounds.clear();
  if (ticker) clearInterval(ticker);
  ticker = null;
}
