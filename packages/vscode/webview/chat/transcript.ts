/**
 * The conversation: your messages (Edit goes back to one), Atlarix's replies
 * (Copy), its thinking (open while it thinks, then folded with how long),
 * quiet steps, edit cards with an ordered diff, command cards with their
 * output, checkpoints after turns that changed files (Compare, Restore), and
 * question cards.
 */
import type { ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { renderMarkdown } from "../../../extension/src/panel/markdown";
import type { ContextItem } from "../../src/protocol";
import { diffRows } from "../logic";
import { post, rpc } from "../rpc";
import { state } from "../state";
import { button, el, icon, rixGlyph } from "../ui";
import { resetSubagents, upsertSubagent, type SubagentMeta } from "./subagents";

/** Atlarix's own marks (src/cli/tui/glyphs.ts). */
const MARK = { reply: "◆", thought: "∴", running: "◌", done: "◇", failed: "✕", recap: "◷" };

export interface TranscriptHooks {
  /** Edit or Restore on one of your messages: go back to it. */
  goBack(messageId: number, text: string, restore: boolean | null): void;
  /** The question card's answers, sent as the next message. */
  answer(text: string, answers: string[]): void;
}

let hooks: TranscriptHooks;
export const log = el("main", "log");
log.setAttribute("aria-live", "polite");

let current: { el: HTMLElement; text: string; kind: "reply" | "thought"; started: number } | null = null;
let renderQueued = false;
const tools = new Map<string, HTMLElement>();
/** This turn: whether it changed files, and the message that started it. */
let turn: { edits: boolean; messageId: number | null } = { edits: false, messageId: null };
let pendingQuestion: Array<{ question: string; options?: string[] }> | null = null;

export function initTranscript(h: TranscriptHooks): void {
  hooks = h;
}

export function questionPending(): Array<{ question: string; options?: string[] }> | null {
  return pendingQuestion;
}

export function clearQuestion(): void {
  pendingQuestion = null;
}

function scrollDown(force = false): void {
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  if (near || force) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
}

/** Empty everything (a new chat, a loaded one, or going back to a message). */
export function resetTranscript(): void {
  log.textContent = "";
  tools.clear();
  resetSubagents();
  current = null;
  turn = { edits: false, messageId: null };
  pendingQuestion = null;
}

export function isEmpty(): boolean {
  return !log.querySelector(".msg, .steps, .card, .tool");
}

/** A turn is over: what it changed gets a checkpoint, and its thinking folds. */
export function endTurn(): void {
  foldThought();
  closeCurrent();
  if (turn.edits && turn.messageId != null) log.append(checkpoint(turn.messageId));
  turn = { edits: false, messageId: turn.messageId };
  scrollDown();
}

// --- Your messages ---------------------------------------------------------------

export function addUser(text: string, items: ContextItem[] = [], messageId?: number): void {
  endTurn();
  log.querySelector(".home")?.remove();
  const m = el("div", "msg user");
  if (items.length) {
    const c = el("div", "msg__chips");
    for (const i of items) c.append(el("span", "chip", i.label.split(/[\\/]/).pop() ?? i.label));
    m.append(c);
  }
  if (text) m.append(el("div", "msg__text", text));
  m.dataset.text = text;
  log.append(m);
  if (messageId != null) tagUser(m, messageId);
  turn = { edits: false, messageId: messageId ?? null };
  scrollDown(true);
}

/** Your message, now saved: it can be gone back to. */
export function tagUser(m: HTMLElement, messageId: number): void {
  m.dataset.id = String(messageId);
  if (!m.querySelector(".msg__edit")) {
    const edit = button("", "msg__edit", () => !state.busy && hooks.goBack(messageId, m.dataset.text ?? "", null), "Edit and send again");
    edit.innerHTML = icon("pencil", 13);
    m.append(edit);
  }
  // The message that started the turn now in progress.
  if (m === log.querySelectorAll(".msg.user")[log.querySelectorAll(".msg.user").length - 1]) turn.messageId = messageId;
}

/** The echo naming the message just drawn. */
export function tagLastUser(messageId: number): void {
  const mine = log.querySelectorAll<HTMLElement>(".msg.user");
  const last = mine[mine.length - 1];
  if (last) tagUser(last, messageId);
}

// --- Replies and thinking --------------------------------------------------------

function flushRender(): void {
  renderQueued = false;
  if (!current) return;
  const body = current.el.querySelector<HTMLElement>(".body")!;
  if (current.kind === "reply") renderMarkdown(body, current.text);
  else {
    body.textContent = current.text;
    body.scrollTop = body.scrollHeight;
  }
  scrollDown();
}

/**
 * The live reply or thought is over: draw what is still waiting for its frame
 * first. Text is drawn once per animation frame, and a tool call arriving in the
 * same frame as the last chunk used to drop that chunk (the reply lost its last
 * words before the step that followed it).
 */
function closeCurrent(): void {
  if (renderQueued) flushRender();
  current = null;
}

let liveThought: HTMLDetailsElement | null = null;
let thoughtStarted = 0;

function foldThought(): void {
  if (!liveThought) return;
  if (!liveThought.dataset.user) liveThought.open = false;
  const secs = Math.max(1, Math.round((Date.now() - thoughtStarted) / 1000));
  const label = liveThought.querySelector(".thought__label");
  if (label) label.textContent = liveThought.dataset.replay ? "Thought" : `Thought for ${secs}s`;
  liveThought = null;
}

export function appendText(kind: "reply" | "thought", text: string, replay = false): void {
  // Whitespace between steps is not a reply: no empty ◆ until there are words.
  if ((!current || current.kind !== kind) && !text.trim()) return;
  log.querySelector(".home")?.remove();
  if (!current || current.kind !== kind) {
    if (kind === "reply") {
      foldThought();
      const m = el("div", "msg agent");
      const cur = { el: m as HTMLElement, text: "", kind, started: Date.now() } as NonNullable<typeof current>;
      const copy = button("", "msg__copy", () => post({ type: "copy", text: cur.text.trim() }), "Copy this reply");
      copy.innerHTML = icon("copy", 13);
      m.append(el("span", "mark", MARK.reply), el("div", "body"), copy);
      log.append(m);
      current = cur;
    } else {
      const d = el("details", "thought");
      const s = el("summary");
      s.append(el("span", "thought__mark", MARK.thought), el("span", "thought__label", replay ? "Thought" : "Thinking"));
      // Open while the model thinks; folded once anything follows it. A click of yours leaves it as you set it.
      d.open = !replay;
      if (replay) d.dataset.replay = "1";
      s.addEventListener("click", () => (d.dataset.user = "1"));
      d.append(s, el("div", "body"));
      log.append(d);
      liveThought = d;
      thoughtStarted = Date.now();
      current = { el: d, text: "", kind, started: Date.now() };
    }
  }
  current.text += text;
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(flushRender);
  }
}

// --- Steps, edits and commands -----------------------------------------------------

function diffCard(c: Extract<ToolCallContent, { type: "diff" }>): HTMLElement {
  const rows = diffRows(c.oldText ?? "", c.newText);
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;
  const card = el("div", "edit-card");
  const head = el("div", "edit-card__head");
  const name = el("span", "edit-card__file");
  name.innerHTML = icon("file", 13);
  name.append(document.createTextNode(` ${c.path.split(/[\\/]/).slice(-2).join("/")}`));
  name.title = c.path;
  head.append(name, el("span", "plus", `+${added}`), el("span", "minus", `−${removed}`), button("Open", "link small", () => post({ type: "open-file", path: c.path })));
  const pre = el("pre", "edit-card__diff");
  for (const r of rows) pre.append(el("div", r.kind, r.kind === "add" ? `+ ${r.text}` : r.kind === "del" ? `- ${r.text}` : r.kind === "gap" ? "  ⋯" : `  ${r.text}`));
  if (!rows.length) pre.append(el("div", "ctx", "(no line changes)"));
  card.append(head, pre);
  return card;
}

/** A command and what it printed: the last lines, the rest a click away. */
function commandCard(title: string, output: string, status: string): HTMLElement {
  const card = el("div", `cmd-card ${status}`);
  const head = el("div", "cmd-card__head");
  head.append(el("span", "cmd-card__mark", status === "completed" ? MARK.done : status === "failed" ? MARK.failed : MARK.running), el("span", "cmd-card__title", title));
  card.append(head);
  const lines = output.replace(/\s+$/, "").split("\n");
  if (output.trim()) {
    const pre = el("pre", "cmd-card__out", lines.slice(-12).join("\n"));
    card.append(pre);
    if (lines.length > 12) {
      card.append(
        button(`Show all ${lines.length} lines`, "link small", (e) => {
          pre.textContent = lines.join("\n");
          (e.currentTarget as HTMLElement).remove();
        }),
      );
    }
  }
  return card;
}

function stepsGroup(): HTMLElement {
  const last = log.lastElementChild;
  if (last?.classList.contains("steps")) return last as HTMLElement;
  const g = el("div", "steps");
  log.append(g);
  return g;
}

/** A tool call: a quiet step, or a card for an edit or a command. */
export function toolCall(t: ToolCallUpdate & { _meta?: unknown; kind?: string | null }): void {
  log.querySelector(".home")?.remove();
  foldThought();
  closeCurrent();
  const peer = (t._meta as { atlarix?: { peer?: { from?: string } } } | undefined)?.atlarix?.peer;
  const existing = tools.get(t.toolCallId);
  const kind = (t.kind ?? existing?.dataset.kind ?? "other") as string;
  const status = t.status ?? existing?.dataset.status ?? "in_progress";
  const title = t.title ?? existing?.dataset.title ?? "";
  const diff = t.content?.find((c) => c.type === "diff") as Extract<ToolCallContent, { type: "diff" }> | undefined;
  const text = t.content
    ?.filter((c) => c.type === "content" && c.content.type === "text")
    .map((c) => ((c as { content: { text: string } }).content.text))
    .join("\n");

  if (peer) {
    const d = el("div", "card peer");
    const head = el("div", "peer__head");
    const scout = el("span", "scout");
    scout.innerHTML = rixGlyph(18);
    head.append(scout, el("strong", "", `Message from ${peer.from || "another session"}`));
    d.append(head, el("div", "peer__text", text ?? ""));
    tools.set(t.toolCallId, d);
    log.append(d);
    return scrollDown();
  }

  // A sub-agent: drawn in its round's panel, the way the app does.
  const sub = (t._meta as { atlarix?: { subagent?: SubagentMeta } } | undefined)?.atlarix?.subagent;
  if (sub || existing?.dataset.card === "subagent") {
    if (sub) {
      const round = upsertSubagent(t.toolCallId, sub);
      if (round) log.append(round);
    }
    if (!existing) {
      const marker = el("span", "hidden");
      marker.dataset.card = "subagent";
      tools.set(t.toolCallId, marker);
    }
    return scrollDown();
  }

  let node: HTMLElement;
  if (kind === "edit" && (diff || existing?.dataset.card === "edit")) {
    node = existing?.dataset.card === "edit" && !diff ? existing : diffCard(diff!);
    node.dataset.card = "edit";
    if (status === "completed") turn.edits = true;
  } else if (kind === "execute") {
    node = commandCard(title || "Command", text ?? existing?.dataset.output ?? "", status);
    node.dataset.output = text ?? existing?.dataset.output ?? "";
  } else {
    node = el("div", `step ${status}`);
    node.append(el("span", "step__mark", status === "completed" ? MARK.done : status === "failed" ? MARK.failed : MARK.running), el("span", "step__title", title));
    if (status === "failed" && text) node.title = text;
    // A step with nothing to name (internal bookkeeping) is a bare mark: hide it.
    node.classList.toggle("hidden", !title.trim());
  }
  Object.assign(node.dataset, { kind, status, title });
  if (existing) existing.replaceWith(node);
  else if (node.classList.contains("step")) stepsGroup().append(node);
  else log.append(node);
  tools.set(t.toolCallId, node);
  scrollDown();
}

// --- Checkpoints ---------------------------------------------------------------------

/** After a turn that changed files: Compare (each file then vs now) and Restore (back to before it). */
function checkpoint(messageId: number): HTMLElement {
  const row = el("div", "checkpoint");
  const files = el("div", "checkpoint__files hidden");
  row.append(
    el("span", "checkpoint__rule"),
    el("span", "", "Checkpoint"),
    button("Compare", "link small", async () => {
      if (!files.classList.contains("hidden")) return files.classList.add("hidden");
      files.textContent = "";
      const r = await rpc<{ files: Array<{ path: string; turnId: string; created: boolean }> }>("_atlarix/checkpoint", {
        sessionId: state.sessionId,
        action: "files",
        messageId,
      }).catch(() => ({ files: [] }));
      if (!r.files.length) files.append(el("span", "muted", "Nothing changed since then."));
      for (const f of r.files) {
        const b = button("", "file-chip", () => post({ type: "compare", turnId: f.turnId, path: f.path }), `Compare ${f.path}`);
        b.innerHTML = icon("file", 12);
        b.append(document.createTextNode(` ${f.path}${f.created ? " (new)" : ""}`));
        files.append(b);
      }
      files.classList.remove("hidden");
      files.scrollIntoView({ block: "nearest" });
    }),
    button("Restore", "link small", () => !state.busy && hooks.goBack(messageId, textOf(messageId), true)),
    el("span", "checkpoint__rule"),
  );
  const wrap = el("div", "checkpoint-wrap");
  wrap.append(row, files);
  return wrap;
}

function textOf(messageId: number): string {
  return log.querySelector<HTMLElement>(`.msg.user[data-id="${messageId}"]`)?.dataset.text ?? "";
}

// --- Questions, errors, recap ------------------------------------------------------------

export function showQuestion(items: Array<{ question: string; options?: string[] }>): void {
  foldThought();
  closeCurrent();
  pendingQuestion = items;
  const card = el("div", "card question");
  const answers: string[] = items.map(() => "");
  items.forEach((q, i) => {
    card.append(el("div", "card__title", q.question));
    const opts = el("div", "card__options");
    const free = el("input", "field");
    free.placeholder = "Or type an answer";
    free.setAttribute("aria-label", `Answer: ${q.question}`);
    for (const o of q.options ?? []) {
      opts.append(
        button(o, "option", () => {
          answers[i] = o;
          free.value = o;
          for (const b of opts.querySelectorAll("button")) b.classList.toggle("chosen", b.textContent === o);
        }),
      );
    }
    free.addEventListener("input", () => (answers[i] = free.value));
    card.append(opts, free);
  });
  card.append(
    button("Answer", "primary", () => {
      const a = answers.map((x) => x.trim() || "(no answer)");
      card.classList.add("answered");
      card.querySelectorAll("button,input").forEach((x) => x.setAttribute("disabled", ""));
      pendingQuestion = null;
      hooks.answer(a.join("\n"), a);
    }),
  );
  log.append(card);
  post({ type: "needs-you", what: items[0]?.question ?? "A question" });
  scrollDown(true);
}

export function showError(text: string, actions: HTMLElement[] = []): void {
  const err = el("div", "error", text);
  if (actions.length) {
    const a = el("div", "card__options");
    a.append(...actions);
    err.append(a);
  }
  log.append(err);
  scrollDown(true);
}

export function showRecap(text: string): void {
  log.querySelector(".recap")?.remove();
  const r = el("div", "recap");
  r.append(el("span", "recap__mark", MARK.recap), el("span", "recap__label", "While you were away"), el("span", "recap__text", text));
  const x = button("", "icon small", () => r.remove(), "Dismiss");
  x.innerHTML = icon("close", 12);
  r.append(x);
  log.append(r);
  scrollDown(true);
}

/** A record, in the conversation, of an approval you answered. */
export function approvalRecord(title: string, answer: string, denied: boolean): void {
  const row = el("div", `step ${denied ? "failed" : "completed"}`);
  row.append(el("span", "step__mark", denied ? MARK.failed : MARK.done), el("span", "step__title", `${title} · ${answer}`));
  stepsGroup().append(row);
}
