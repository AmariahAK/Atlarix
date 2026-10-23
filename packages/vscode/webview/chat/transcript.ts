/**
 * The conversation: your messages (Edit goes back to one), Atlarix's replies
 * (Copy), its thinking (open while it thinks, then folded with how long),
 * quiet steps, edit cards with an ordered diff, command cards with their
 * output, checkpoints after turns that changed files (Compare, Restore), and
 * question cards.
 */
import type { ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { linkifyText, renderMarkdown } from "../../../extension/src/panel/markdown";
import type { ContextItem } from "../../src/protocol";
import { diffRows } from "../logic";
import { post, rpc } from "../rpc";
import { state } from "../state";
import { button, el, icon, rixGlyph } from "../ui";
import { addCodeCopyButtons } from "./code-copy";
import { drawFence } from "./diagrams";
import { resetSubagents, upsertSubagent, type SubagentMeta } from "./subagents";

/** Atlarix's own marks (src/cli/tui/glyphs.ts). */
const MARK = { reply: "◆", thought: "∴", running: "◌", done: "◇", failed: "✕", recap: "◷" };

export interface TranscriptHooks {
  /** Edit or Restore on one of your messages: go back to it. */
  goBack(messageId: number, text: string, restore: boolean | null): void;
  /** The question card's answers, sent as the next message. */
  answer(text: string, answers: string[]): void;
  /** A checkpoint's Restore: files only, or files and the message to edit. */
  restore(messageId: number, text: string, anchor: HTMLElement): void;
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

/** One quiet line in the transcript: something that happened, not a message. */
export function addNote(text: string): void {
  log.append(el("div", "note-line", text));
  log.lastElementChild?.scrollIntoView({ block: "nearest" });
}

export function questionPending(): Array<{ question: string; options?: string[] }> | null {
  return pendingQuestion;
}

export function clearQuestion(): void {
  pendingQuestion = null;
}

/**
 * Follow the conversation while you are at its end. The element that scrolls
 * is the chat around the log (the task card sits above it in the same scroller),
 * not the log itself, which only grows.
 */
function scrollDown(force = false): void {
  const sc = watchScroller();
  if (force) following = true;
  if (following) requestAnimationFrame(() => (sc.scrollTop = sc.scrollHeight));
}

/**
 * Whether to keep to the end: yes until YOU scroll away from it, and again once
 * you scroll back. It used to be measured after new content landed, so one big
 * piece (an expanded command's output, the plan card above) put the end out of
 * reach and the panel stopped following for the rest of the turn (QA P3).
 */
let following = true;
let lastUserInput = 0;
let watched: HTMLElement | null = null;

function watchScroller(): HTMLElement {
  const sc = log.parentElement ?? log;
  if (watched === sc) return sc;
  watched = sc;
  const intent = () => (lastUserInput = Date.now());
  for (const ev of ["wheel", "touchmove", "keydown", "mousedown"]) sc.addEventListener(ev, intent, { passive: true });
  sc.addEventListener(
    "scroll",
    () => {
      // Only your own scrolling decides; content growing never does.
      if (Date.now() - lastUserInput > 600) return;
      following = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
    },
    { passive: true },
  );
  // Content that grows by itself (an output expanding, a card filling in).
  new ResizeObserver(() => {
    if (following) sc.scrollTop = sc.scrollHeight;
  }).observe(log);
  return sc;
}

/** Empty everything (a new chat, a loaded one, or going back to a message). */
export function resetTranscript(): void {
  log.textContent = "";
  tools.clear();
  resetSubagents();
  userOpen.clear();
  turnCards = [];
  current = null;
  turn = { edits: false, messageId: null };
  pendingQuestion = null;
}

export function isEmpty(): boolean {
  return !log.querySelector(".msg, .steps, .card, .tool");
}

/** A new turn begins: its words start a reply of their own, never the end of the last one. */
export function beginTurn(): void {
  clearPlanReady();
  foldThought();
  closeCurrent();
  turnCards = [];
  turnFirst = log.lastElementChild;
  turnStartedAt = Date.now();
}

/** Where this turn's content starts (the element before it), and when it began. */
let turnFirst: Element | null = null;
let turnStartedAt = 0;

/**
 * A finished turn folds what it did on the way (thinking, steps, notes to
 * itself) under one line above its answer: "Worked for 1m 30s · 31 steps".
 * Without it a long turn left forty rows between the question and the answer
 * (QA). Open it to see every step; nothing is removed.
 */
function foldFinishedWork(): void {
  if (!turnStartedAt) return;
  const els: Element[] = [];
  for (let n = turnFirst ? turnFirst.nextElementSibling : log.firstElementChild; n; n = n.nextElementSibling) els.push(n);
  const secs = Math.max(1, Math.round((Date.now() - turnStartedAt) / 1000));
  foldWork(els, secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`);
}

/**
 * A reopened chat folds its finished turns the same way (QA #46: 64 rows, no
 * fold). Each turn runs from one of your messages to the next; the replay has
 * no clock, so the line says only how many steps.
 */
export function foldReplayedTurns(): void {
  let turnEls: Element[] = [];
  const flush = () => {
    foldWork(turnEls, null);
    turnEls = [];
  };
  for (const n of [...log.children]) {
    if (n.classList.contains("msg") && n.classList.contains("user")) {
      flush();
      continue;
    }
    if (!n.classList.contains("worked")) turnEls.push(n);
  }
  flush();
}

/** Fold a turn's work (everything before its last reply) under one line. */
function foldWork(els: Element[], took: string | null): void {
  let final = -1;
  els.forEach((e, i) => {
    if (e.classList.contains("msg") && e.classList.contains("agent")) final = i;
  });
  const work = final > 0 ? els.slice(0, final).filter((e) => !e.classList.contains("user") && !e.classList.contains("wake-line")) : [];
  const steps = work.reduce((n, e) => n + (e.matches(".step, .cmd-card, .edit-card, .agents") ? 1 : 0) + e.querySelectorAll(".step, .agent").length, 0);
  if (work.length < 3 || steps < 2) return;
  const d = el("details", "worked");
  const s = el("summary", "worked__head");
  const stepsText = `${steps} step${steps === 1 ? "" : "s"}`;
  s.append(el("span", "worked__mark", MARK.done), el("span", "", took ? `Worked for ${took} · ${stepsText}` : `Worked · ${stepsText}`));
  const body = el("div", "worked__body");
  d.append(s, body);
  els[final]!.before(d);
  for (const e of work) body.append(e);
}

/** A turn is over: what it changed gets a checkpoint, and its thinking folds. */
export function endTurn(stopped = false): void {
  foldThought();
  closeCurrent();
  foldFinishedWork();
  // Where the turn was cut off, as the terminal says it (QA #45).
  if (stopped) log.append(el("div", "turn-stopped", "Interrupted. Tell Atlarix what to do instead."));
  turnStartedAt = 0;
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

/** Whether your last message on screen is still waiting for its saved id. */
export function lastUserAwaitsId(): boolean {
  const mine = log.querySelectorAll<HTMLElement>(".msg.user");
  const last = mine[mine.length - 1];
  return !!last && last.dataset.id == null;
}

/** The echo naming the message just drawn. */
export function tagLastUser(messageId: number): void {
  const mine = log.querySelectorAll<HTMLElement>(".msg.user");
  const last = mine[mine.length - 1];
  if (last) tagUser(last, messageId);
}

// --- Replies and thinking --------------------------------------------------------

/** Markdown, with a copy button on each code block. */
function renderReply(body: HTMLElement, markdown: string): void {
  renderMarkdown(body, markdown, { fence: drawFence });
  addCodeCopyButtons(body, (text) => post({ type: "copy", text }));
}

function flushRender(): void {
  renderQueued = false;
  if (!current) return;
  const body = current.el.querySelector<HTMLElement>(".body")!;
  if (current.kind === "reply") renderReply(body, current.text);
  else {
    body.textContent = current.text.trim();
    current.el.dataset.text = current.text;
    body.scrollTop = body.scrollHeight;
    const time = current.el.querySelector(".thought__time");
    if (time && current.el.classList.contains("live")) time.textContent = ` · ${Math.max(1, Math.round((Date.now() - current.started) / 1000))}s`;
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

/**
 * What a finished thought was about, in one line: its bold title when it has
 * one (models often open with `**Checking the routes**`), else its first
 * sentence.
 */
export function thoughtSummary(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // Inline markdown out: "`ToolPart` — where…" reads as "ToolPart — where…".
  const plain = (s: string) => s.replace(/\*\*|__|`/g, "");
  const title = /^\*\*(.+?)\*\*:?$/.exec(lines[0] ?? "")?.[1];
  if (title) return plain(title);
  const sentence = firstSentenceOf(plain(lines[0] ?? ""));
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

/** Where a line's first sentence ends, not at "e.g." / "i.e." / "etc." (QA saw "Now a representative tool, e.g."). */
function firstSentenceOf(line: string): string {
  const end = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = end.exec(line)) !== null) {
    const upTo = line.slice(0, m.index + 1);
    if (/\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\.$/i.test(upTo) || /(?:^|\s)[A-Za-z]\.$/.test(upTo)) continue;
    return upTo;
  }
  return line;
}


/**
 * The thought is over: fold it to one line saying what it was about and how
 * long it took (the app's thought block). Open it for the whole text. A thought
 * under a second and one line long is just that line.
 */
function foldThought(): void {
  if (!liveThought) return;
  const d = liveThought;
  liveThought = null;
  if (current?.el === d) closeCurrent();
  const text = d.dataset.text ?? d.querySelector(".body")?.textContent ?? "";
  const ms = Date.now() - thoughtStarted;
  const secs = Math.round(ms / 1000);
  const oneLine = text.trim().split("\n").filter((l) => l.trim()).length <= 1;
  d.classList.remove("live");
  if (!d.dataset.user) d.open = false;
  const label = d.querySelector(".thought__label");
  const time = d.querySelector(".thought__time");
  if (label) label.textContent = thoughtSummary(text) || "Thought";
  if (time) time.textContent = d.dataset.replay || (secs < 1 && oneLine) ? "" : ` · ${Math.max(1, secs)}s`;
  d.classList.toggle("plain", oneLine);
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
      const d = el("details", replay ? "thought" : "thought live");
      const s = el("summary");
      s.append(el("span", "thought__mark", MARK.thought), el("span", "thought__label", replay ? "Thought" : "Thinking"), el("span", "thought__time"));
      // Open while the model thinks (its latest lines); folded to one line once
      // anything follows it. A click of yours leaves it as you set it.
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
    // A dev server's address in the output is a link (the CLI's OSC 8, ACP's resource_link).
    const pre = el("pre", "cmd-card__out");
    linkifyText(pre, lines.slice(-12).join("\n"));
    card.append(pre);
    if (lines.length > 12) {
      card.append(
        button(`Show all ${lines.length} lines`, "link small", (e) => {
          pre.replaceChildren();
          linkifyText(pre, lines.join("\n"));
          (e.currentTarget as HTMLElement).remove();
        }),
      );
    }
  }
  return card;
}

// --- Folding edit and command cards, as the app does ------------------------------------

/** Your own open/close of a card, by tool call: it wins over every default. */
const userOpen = new Map<string, boolean>();
/** This turn's edit and command cards, oldest first: only the last few stay open. */
let turnCards: string[] = [];
const OPEN_RECENT = 3;

/**
 * Whether a card shows its body (the app's rule, tool-expand-view.ts
 * defaultOpenFor): your choice first; a failure stays open; a running call is
 * closed; a finished edit or command is open while it is one of the turn's
 * last few steps, then folds to its one line.
 */
function cardOpen(id: string, status: string): boolean {
  const mine = userOpen.get(id);
  if (mine != null) return mine;
  if (status === "failed") return true;
  if (status === "in_progress" || status === "pending") return false;
  const i = turnCards.indexOf(id);
  return i < 0 || i >= turnCards.length - OPEN_RECENT;
}

/** Give a card a header that opens and closes it, and draw it open or closed. */
function foldable(node: HTMLElement, id: string, status: string): void {
  const head = node.querySelector<HTMLElement>(".cmd-card__head, .edit-card__head");
  const body = [...node.children].filter((c) => c !== head) as HTMLElement[];
  if (!head || !body.length) return;
  const chev = el("span", "fold__chev");
  head.prepend(chev);
  head.classList.add("fold__head");
  head.tabIndex = 0;
  head.setAttribute("role", "button");
  const apply = () => {
    const open = cardOpen(id, node.dataset.status ?? status);
    for (const b of body) b.classList.toggle("hidden", !open);
    chev.textContent = open ? "▾" : "▸";
    head.setAttribute("aria-expanded", String(open));
  };
  const toggle = (e: Event) => {
    // The header's own buttons (Open) do their own thing.
    if ((e.target as HTMLElement).closest("button")) return;
    userOpen.set(id, !cardOpen(id, node.dataset.status ?? status));
    apply();
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(e);
    }
  });
  node.dataset.fold = "1";
  apply();
}

/** A new card joined the turn: the ones it pushed out of the last few fold. */
function foldOlder(): void {
  for (const id of turnCards.slice(0, -OPEN_RECENT)) {
    const n = tools.get(id);
    if (!n?.dataset.fold || userOpen.has(id)) continue;
    const open = cardOpen(id, n.dataset.status ?? "");
    const head = n.querySelector<HTMLElement>(".fold__head");
    for (const b of [...n.children].filter((c) => c !== head) as HTMLElement[]) b.classList.toggle("hidden", !open);
    const chev = n.querySelector(".fold__chev");
    if (chev) chev.textContent = open ? "▾" : "▸";
    head?.setAttribute("aria-expanded", String(open));
  }
}

function stepsGroup(): HTMLElement {
  const last = log.lastElementChild;
  if (last?.classList.contains("steps")) return last as HTMLElement;
  const g = el("div", "steps");
  log.append(g);
  return g;
}

/** A plan step with the plan under it, open; its header folds it. */
function planStep(step: HTMLElement, markdown: string): HTMLElement {
  const box = el("div", "plan-step");
  const body = el("div", "plan-step__body body md");
  renderReply(body, markdown);
  step.classList.add("plan-step__head");
  step.addEventListener("click", () => box.classList.toggle("folded"));
  box.append(step, body);
  return box;
}

/** A tool call: a quiet step, or a card for an edit or a command. */
export function toolCall(t: ToolCallUpdate & { _meta?: unknown; kind?: string | null }): void {
  log.querySelector(".home")?.remove();
  // Only a NEW step ends the reply or thought in progress. An update to a call
  // already on screen (its status, its output) changes that call and nothing
  // else: treating it as a break split one reply into many and stacked up
  // empty thought blocks.
  if (!tools.has(t.toolCallId)) {
    foldThought();
    closeCurrent();
  }
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
    const body = el("div", "peer__text");
    linkifyText(body, text ?? "");
    d.append(head, body);
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
    const approved = t.toolCallId.startsWith("approved:");
    // What you approved wraps: cut short, the file or rule at its end was lost (QA).
    node = el("div", `step ${status}${approved ? " step--approved" : ""}`);
    const head = el("span", "step__title", approved ? "" : title);
    // What you approved names the command or file in backticks: drawn as code, not as "`npm`".
    if (approved) title.split("`").forEach((s, i) => s && head.append(i % 2 ? el("code", "", s) : s));
    node.append(el("span", "step__mark", status === "completed" ? MARK.done : status === "failed" ? MARK.failed : MARK.running), head);
    if (status === "failed" && text) {
      // Why it failed, on a line of its own (the CLI's "╰ reason"); all of it on hover.
      node.title = text;
      const why = text.trim().split("\n").find((l) => l.trim()) ?? "";
      if (why) {
        const line = el("span", "step__why");
        linkifyText(line, why.trim());
        node.append(line);
      }
    }
    // A step with nothing to name (internal bookkeeping) is a bare mark: hide it.
    node.classList.toggle("hidden", !title.trim());
    // A plan the agent wrote: the plan itself, open, to read and correct where
    // it was written (owner: the card above scrolls out of view).
    const isPlan = (t._meta as { atlarix?: { planBody?: boolean } } | undefined)?.atlarix?.planBody || existing?.dataset.plan === "1";
    const planText = text?.trim() || existing?.dataset.planText || "";
    if (isPlan && planText) {
      node = planStep(node, planText);
      node.dataset.planText = planText;
    }
    // Remembered before its text arrives: the update that brings it has no _meta.
    if (isPlan) node.dataset.plan = "1";
  }
  Object.assign(node.dataset, { kind, status, title });
  if (node.classList.contains("cmd-card") || node.classList.contains("edit-card")) {
    if (!turnCards.includes(t.toolCallId)) turnCards.push(t.toolCallId);
    // A card redrawn with the same body keeps its fold (and so does an edit
    // card kept as it was, which already has its header).
    if (!node.dataset.fold) foldable(node, t.toolCallId, status);
  }
  if (existing) existing.replaceWith(node);
  else if (t.toolCallId.startsWith("wake:")) {
    // Why the agent woke ("◇ Map src/routes finished") is its own line, kept
    // outside the turn's fold (QA #47).
    const line = el("div", "steps wake-line");
    line.append(node);
    log.append(line);
  } else if (node.classList.contains("step")) stepsGroup().append(node);
  else log.append(node);
  tools.set(t.toolCallId, node);
  foldOlder();
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
    button("Restore", "link small", () => !state.busy && hooks.restore(messageId, textOf(messageId), wrap)),
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

/**
 * "Plan ready · Build it" where the plan turn ENDS: the card with its button is
 * at the top, out of view after a long turn, and the reply itself may say
 * "switch to Build" not knowing the button exists (QA P4; Claude Code asks at
 * the end). One at a time; it goes once the plan is no longer waiting.
 */
export function showPlanReady(title: string, resume: boolean, onBuild: () => void): void {
  clearPlanReady();
  const row = el("div", "plan-ready");
  row.append(el("span", "plan-ready__label", `${resume ? "Stopped part-way" : "Plan ready"} · ${title}`));
  row.append(button(resume ? "Continue building" : "Build it", "primary small", onBuild));
  log.append(row);
  scrollDown();
}

export function clearPlanReady(): void {
  log.querySelectorAll(".plan-ready").forEach((x) => x.remove());
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
