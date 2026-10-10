/**
 * The chat, drawn in the editor's webview. Vanilla DOM, like the Chrome side
 * panel, and the same rule: model output never goes through innerHTML (the
 * markdown renderer builds nodes). The only markup set as HTML is Rix, which
 * is ours.
 */
import type { SessionConfigOption, SessionUpdate, ToolCallContent, ToolCallUpdate, PermissionOption } from "@agentclientprotocol/sdk";
import { rixSvg, setRixState, type RixState } from "@/lib/rix/rix-svg";
import { renderMarkdown } from "../../extension/src/panel/markdown";
import type { ContextItem, HostMessage, PastSession, ViewMessage } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(m: ViewMessage): void };
const vscode = acquireVsCodeApi();
const post = (m: ViewMessage) => vscode.postMessage(m);

/** Atlarix's own marks (src/cli/tui/glyphs.ts). */
const MARK = { reply: "◆", thought: "∴", running: "◌", done: "◇", failed: "✕", result: "╰", recap: "◷" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", cls, label);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  b.addEventListener("click", onClick);
  return b;
}

// --- Layout ------------------------------------------------------------------

const app = document.getElementById("app")!;
const top = el("header", "top");
const rixHost = el("div", "rix-host");
rixHost.innerHTML = rixSvg({ state: "rest", size: "34px", detail: "mid", label: "" });
const titleEl = el("div", "title", "New chat");
const menuBtn = button("⋯", "icon", () => toggleMenu(), "More");
// In the side bar VS Code draws New chat and Past chats in the view's title; in a tab they are here.
const tabButtons = [button("↺", "icon", () => post({ type: "history" }), "Past chats"), button("+", "icon", () => post({ type: "new-chat" }), "New chat")];
for (const b of tabButtons) b.classList.add("hidden");
top.append(rixHost, titleEl, ...tabButtons, menuBtn);

const menu = el("div", "menu hidden");
const recapItem = button("Session recap: on", "menu__item", () => {
  recapOn = !recapOn;
  recapItem.textContent = `Session recap: ${recapOn ? "on" : "off"}`;
  post({ type: "recap-setting", on: recapOn });
});
menu.append(
  button("Open in an editor tab", "menu__item", () => post({ type: "open-in-tab" })),
  recapItem,
  button("Sign in", "menu__item", () => post({ type: "sign-in" })),
  button("Show log", "menu__item", () => post({ type: "show-log" })),
);

const notice = el("div", "notice hidden");
const log = el("main", "log");
log.setAttribute("aria-live", "polite");
const planBox = el("section", "plan hidden");
// The composer: one rounded box — attachments, the text, then a bar with
// attach, mode and model on the left and send on the right. Status (context,
// cost, Chrome) sits on a quiet line under it.
const composer = el("footer", "composer");
const box = el("div", "box");
const chips = el("div", "chips");
const input = el("textarea", "input");
input.rows = 2;
input.placeholder = "Ask Atlarix to build, fix or explain…";
const bar = el("div", "bar");
const attachBtn = button("+", "pill icon-pill", () => attachMenu.classList.toggle("hidden"), "Attach a file or image");
const attachMenu = el("div", "menu attach-menu hidden");
attachMenu.append(
  button("File…   @", "menu__item", () => {
    attachMenu.classList.add("hidden");
    post({ type: "pick-file" });
  }),
  button("Image…", "menu__item", () => {
    attachMenu.classList.add("hidden");
    post({ type: "pick-image" });
  }),
);
const pill = (sel: HTMLSelectElement, label: string) => {
  const wrap = el("label", "pill select-pill");
  wrap.title = label;
  sel.setAttribute("aria-label", label);
  wrap.append(sel, el("span", "chev", "▾"));
  return wrap;
};
const modeSel = el("select", "select");
const modelSel = el("select", "select model");
const sendBtn = button("↑", "send", () => submit(), "Send (Enter)");
sendBtn.dataset.state = "idle";
const modePill = pill(modeSel, "Mode");
modePill.classList.add("mode-pill");
const modelPill = pill(modelSel, "Model");
modelPill.classList.add("model-pill");
bar.append(attachBtn, modePill, el("span", "spacer"), sendBtn);
box.append(chips, input, bar);
const statusRow = el("div", "status-row");
const status = el("span", "status");
const chromeDot = el("span", "chrome", "● Chrome");
statusRow.append(modelPill, status, el("span", "spacer"), chromeDot);
composer.append(attachMenu, box, statusRow);
const history = el("div", "history hidden");
app.append(top, menu, notice, log, planBox, composer, history);

// --- State -------------------------------------------------------------------

let busy = false;
let shownSession: string | null = null;
let pendingTitle: string | null = null;
let mode = "build";
let recapOn = true;
let context: ContextItem[] = [];
let current: { el: HTMLElement; text: string; kind: "reply" | "thought" } | null = null;
const tools = new Map<string, HTMLDetailsElement>();
const perms = new Map<string, HTMLElement>();
let pendingQuestion: Array<{ question: string; options?: string[] }> | null = null;
let renderQueued = false;
let foundTimer: ReturnType<typeof setTimeout> | null = null;

const rix = () => rixHost.querySelector("svg");
function setRix(s: RixState) {
  setRixState(rix(), s);
}

function setBusy(b: boolean) {
  busy = b;
  sendBtn.textContent = b ? "■" : "↑";
  sendBtn.title = b ? "Stop (Esc)" : "Send (Enter)";
  sendBtn.setAttribute("aria-label", sendBtn.title);
  sendBtn.dataset.state = b ? "busy" : "idle";
  sendBtn.classList.toggle("stop", b);
  if (foundTimer) clearTimeout(foundTimer);
  if (b) setRix("working");
  else {
    setRix("found");
    foundTimer = setTimeout(() => setRix("rest"), 1400);
  }
  refreshPlanButton();
}

function scrollDown() {
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  if (near) requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
}

function showEmpty() {
  log.textContent = "";
  const empty = el("div", "empty");
  const big = el("div", "empty__rix");
  big.innerHTML = rixSvg({ state: "rest", size: "120px", label: "Rix, the Atlarix ant" });
  empty.append(
    big,
    el("div", "empty__title", "What are we building?"),
    el("div", "empty__hint", "Atlarix edits, runs and researches in this folder. Every change and command waits for your yes in Build mode."),
    el("div", "empty__hint", "Select code and press ⌘⌥L (Ctrl+Alt+L) to add it here."),
  );
  log.append(empty);
}

function clearEmpty() {
  log.querySelector(".empty")?.remove();
}

function setNotice(text: string | null, actions: Array<[string, () => void]> = []) {
  notice.textContent = "";
  notice.classList.toggle("hidden", !text);
  if (!text) return;
  notice.append(el("span", "", text));
  for (const [label, fn] of actions) notice.append(button(label, "link", fn));
}

// --- Messages ----------------------------------------------------------------

function addUser(text: string, items: ContextItem[] = []) {
  clearEmpty();
  current = null;
  const m = el("div", "msg user");
  if (items.length) {
    const c = el("div", "msg__chips");
    for (const i of items) c.append(el("span", "chip", i.label));
    m.append(c);
  }
  if (text) m.append(el("div", "msg__text", text));
  log.append(m);
  log.scrollTop = log.scrollHeight;
}

function flushRender() {
  renderQueued = false;
  if (!current) return;
  const body = current.el.querySelector<HTMLElement>(".body")!;
  if (current.kind === "reply") renderMarkdown(body, current.text);
  else body.textContent = current.text;
  scrollDown();
}

function appendText(kind: "reply" | "thought", text: string) {
  clearEmpty();
  if (!current || current.kind !== kind) {
    if (kind === "reply") {
      const m = el("div", "msg agent");
      m.append(el("span", "mark", MARK.reply), el("div", "body"));
      log.append(m);
      current = { el: m, text: "", kind };
    } else {
      const d = el("details", "thought");
      const s = el("summary", "", `${MARK.thought} Thinking`);
      d.append(s, el("div", "body"));
      log.append(d);
      current = { el: d, text: "", kind };
    }
  }
  current.text += text;
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(flushRender);
  }
}

function diffView(c: Extract<ToolCallContent, { type: "diff" }>): HTMLElement {
  const box = el("div", "diff");
  const name = el("button", "diff__path", c.path.split(/[\\/]/).pop() ?? c.path);
  name.type = "button";
  name.addEventListener("click", () => post({ type: "open-file", path: c.path }));
  box.append(name);
  const pre = el("pre");
  const old = (c.oldText ?? "").split("\n");
  const neu = c.newText.split("\n");
  for (const l of old) if (l && !neu.includes(l)) pre.append(el("div", "del", `- ${l}`));
  for (const l of neu) if (l && !old.includes(l)) pre.append(el("div", "add", `+ ${l}`));
  if (!pre.childElementCount) pre.append(el("div", "", "(no line changes)"));
  box.append(pre);
  return box;
}

function fillTool(d: HTMLDetailsElement, t: ToolCallUpdate) {
  const st = t.status ?? d.dataset.status ?? "in_progress";
  d.dataset.status = st;
  const markEl = d.querySelector(".tool__mark")!;
  markEl.textContent = st === "completed" ? MARK.done : st === "failed" ? MARK.failed : MARK.running;
  if (t.title) d.querySelector(".tool__title")!.textContent = t.title;
  if (t.content?.length) {
    const body = d.querySelector(".tool__body")!;
    body.textContent = "";
    for (const c of t.content) {
      if (c.type === "diff") body.append(diffView(c));
      else if (c.type === "content" && c.content.type === "text") body.append(el("pre", "", c.content.text));
    }
  }
}

function addTool(t: ToolCallUpdate & { _meta?: unknown }) {
  clearEmpty();
  current = null;
  const peer = (t._meta as { atlarix?: { peer?: { from?: string } } } | undefined)?.atlarix?.peer;
  const d = el("details", peer ? "tool peer" : "tool");
  const s = el("summary");
  if (peer) {
    const scout = el("span", "scout");
    scout.innerHTML = rixSvg({ state: "scout", size: "22px", detail: "mid", label: "" });
    s.append(scout, el("span", "tool__mark hidden"), el("span", "tool__title", `Message from ${peer.from || "another session"}`));
    d.open = true;
  } else {
    s.append(el("span", "tool__mark"), el("span", "tool__title"));
  }
  d.append(s, el("div", "tool__body"));
  tools.set(t.toolCallId, d);
  fillTool(d, t);
  if (peer) log.append(d);
  else stepsGroup().append(d);
  scrollDown();
}

/**
 * Consecutive tool steps share one quiet block (grey, smaller, a guide line on
 * the left), so Atlarix's own reply is the only full-strength text and a step
 * is never mistaken for an answer.
 */
function stepsGroup(): HTMLElement {
  const last = log.lastElementChild;
  if (last?.classList.contains("steps")) return last as HTMLElement;
  const g = el("div", "steps");
  log.append(g);
  return g;
}

function onUpdate(u: SessionUpdate) {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const q = (u as { _meta?: { atlarix?: { question?: { items: Array<{ question: string; options?: string[] }> } } } })._meta?.atlarix?.question;
      if (q) return showQuestion(q.items);
      if (u.content.type === "text") appendText("reply", u.content.text);
      return;
    }
    case "agent_thought_chunk":
      if (u.content.type === "text") appendText("thought", u.content.text);
      return;
    case "user_message_chunk":
      if (u.content.type === "text") addUser(u.content.text);
      return;
    case "tool_call":
      if (tools.has(u.toolCallId)) fillTool(tools.get(u.toolCallId)!, u);
      else addTool(u);
      return;
    case "tool_call_update": {
      const d = tools.get(u.toolCallId);
      if (d) fillTool(d, u);
      else addTool(u);
      return;
    }
    case "plan":
      return showPlan(u as { entries: Array<{ content: string; status: string }>; _meta?: unknown });
    case "current_mode_update":
      mode = u.currentModeId;
      modeSel.value = mode;
      fitSelect(modeSel);
      refreshPlanButton();
      return;
    case "config_option_update":
      return setOptions(u.configOptions);
    case "usage_update": {
      const pct = u.size ? Math.round((u.used / u.size) * 100) : null;
      const cost = (u as { cost?: { amount: number } }).cost?.amount;
      status.textContent = [pct != null ? `context ${pct}%` : null, cost ? `$${cost.toFixed(cost < 1 ? 3 : 2)}` : null].filter(Boolean).join(" · ");
      return;
    }
    case "session_info_update":
      if (u.title) titleEl.textContent = u.title;
      return;
    default:
      return;
  }
}

// --- Plan --------------------------------------------------------------------

let planBuildable = false;
function refreshPlanButton() {
  planBox.querySelector<HTMLButtonElement>(".plan__build")?.toggleAttribute("disabled", busy || !planBuildable);
}

function showPlan(p: { entries: Array<{ content: string; status: string }>; _meta?: unknown }) {
  const doc = (p._meta as { atlarix?: { plan?: { title?: string; content?: string; buildable?: boolean } } } | undefined)?.atlarix?.plan;
  planBox.textContent = "";
  if (!p.entries.length && !doc) {
    planBox.classList.add("hidden");
    return;
  }
  planBox.classList.remove("hidden");
  planBuildable = !!doc?.buildable;
  const head = el("div", "plan__head");
  head.append(el("span", "plan__title", doc?.title ?? "Plan"));
  if (doc?.buildable) head.append(button("Build it", "plan__build primary", () => post({ type: "build" }), "Build this plan"));
  planBox.append(head);
  const list = el("ol", "plan__steps");
  for (const e of p.entries) {
    const li = el("li", `step ${e.status}`);
    renderMarkdown(li, e.content);
    list.append(li);
  }
  planBox.append(list);
  if (doc?.content) {
    const more = el("details", "plan__doc");
    more.append(el("summary", "", "Whole plan"));
    const body = el("div", "body");
    renderMarkdown(body, doc.content);
    more.append(body);
    planBox.append(more);
  }
  refreshPlanButton();
}

// --- Questions and approvals ---------------------------------------------------

function showQuestion(items: Array<{ question: string; options?: string[] }>) {
  clearEmpty();
  current = null;
  pendingQuestion = items;
  const card = el("div", "card question");
  const answers: string[] = items.map(() => "");
  items.forEach((q, i) => {
    card.append(el("div", "card__title", `? ${q.question}`));
    const opts = el("div", "card__options");
    const free = el("input", "card__input");
    free.placeholder = "Or type an answer";
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
      sendText(a.join("\n"), [], a);
    }),
  );
  log.append(card);
  scrollDown();
}

function showPermission(requestId: string, toolCall: ToolCallUpdate, options: PermissionOption[], hasDiff: boolean) {
  clearEmpty();
  current = null;
  const card = el("div", "card permission");
  const owner = tools.get(toolCall.toolCallId);
  const title = toolCall.title ?? owner?.querySelector(".tool__title")?.textContent ?? "Atlarix wants to continue";
  card.append(el("div", "card__title", title));
  for (const c of toolCall.content ?? []) {
    if (c.type === "content" && c.content.type === "text") card.append(el("pre", "card__note", c.content.text));
  }
  const acts = el("div", "card__options");
  if (hasDiff) acts.append(button("View diff", "link", () => post({ type: "open-diff", requestId })));
  for (const o of options) {
    const cls = o.kind.startsWith("reject") ? "deny" : o.kind === "allow_once" ? "primary" : "";
    acts.append(button(o.name, cls, () => post({ type: "permission", requestId, optionId: o.optionId })));
  }
  card.append(acts);
  perms.set(requestId, card);
  log.append(card);
  log.scrollTop = log.scrollHeight;
}

// --- Composer ----------------------------------------------------------------

function setOptions(opts: SessionConfigOption[]) {
  for (const o of opts) {
    if (o.type !== "select") continue;
    const sel = o.id === "mode" ? modeSel : o.id === "model" ? modelSel : null;
    if (!sel) continue;
    sel.textContent = "";
    const flat = (o.options as Array<{ value: string; name: string } | { options: Array<{ value: string; name: string }> }>).flatMap((x) =>
      "options" in x ? x.options : [x],
    );
    for (const x of flat) {
      const op = el("option", "", x.name);
      op.value = x.value;
      sel.append(op);
    }
    sel.value = String(o.currentValue);
    fitSelect(sel);
    if (o.id === "mode") mode = String(o.currentValue);
  }
}

/** A select is as wide as its LONGEST option; size it to the one shown, so both pills fit a narrow side bar. */
const measure = document.createElement("canvas").getContext("2d");
function fitSelect(sel: HTMLSelectElement) {
  const text = sel.selectedOptions[0]?.textContent ?? "";
  if (!measure) {
    sel.style.width = `${Math.max(3, text.length) + 0.5}ch`;
    return;
  }
  measure.font = getComputedStyle(sel).font;
  sel.style.width = `${Math.ceil(measure.measureText(text).width) + 4}px`;
}
modeSel.addEventListener("change", () => {
  fitSelect(modeSel);
  post({ type: "set-mode", mode: modeSel.value });
});
modelSel.addEventListener("change", () => {
  fitSelect(modelSel);
  post({ type: "set-model", value: modelSel.value });
});

function renderChips() {
  chips.textContent = "";
  context.forEach((c, i) => {
    const chip = el("span", "chip", c.label);
    chip.append(
      button("×", "chip__x", () => {
        context.splice(i, 1);
        renderChips();
      }, `Remove ${c.label}`),
    );
    chips.append(chip);
  });
}

function sendText(text: string, items: ContextItem[], answers?: string[]) {
  if (busy) return;
  addUser(text, items);
  setBusy(true);
  post({ type: "send", text, context: items, ...(answers ? { answers } : {}) });
}

function submit() {
  if (busy) return post({ type: "cancel" });
  const text = input.value.trim();
  if (!text && !context.length) return;
  if (pendingQuestion) {
    // Typed instead of using the card: that is the answer to every question.
    sendText(text, [], pendingQuestion.map(() => text));
    pendingQuestion = null;
  } else sendText(text, context);
  input.value = "";
  context = [];
  renderChips();
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape" && busy) post({ type: "cancel" });
  else if (e.key === "@") {
    const before = input.value.slice(0, input.selectionStart ?? 0);
    if (!before || /\s$/.test(before)) {
      e.preventDefault();
      post({ type: "pick-file" });
    }
  }
});

// --- History, menu, recap ---------------------------------------------------------

function showHistory(sessions: PastSession[]) {
  history.textContent = "";
  history.classList.remove("hidden");
  const head = el("div", "history__head");
  head.append(el("span", "", "Past chats in this folder"), button("×", "icon", () => history.classList.add("hidden"), "Close"));
  history.append(head);
  if (!sessions.length) history.append(el("div", "history__empty", "No past chats here yet."));
  for (const s of sessions) {
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : "";
    const b = button("", "history__item", () => {
      history.classList.add("hidden");
      post({ type: "load-session", sessionId: s.sessionId });
      pendingTitle = s.title || "Untitled";
    });
    b.append(el("span", "history__title", s.title || "Untitled"), el("span", "history__when", when));
    history.append(b);
  }
}

function toggleMenu() {
  menu.classList.toggle("hidden");
}
document.addEventListener("click", (e) => {
  if (!menu.contains(e.target as Node) && e.target !== menuBtn) menu.classList.add("hidden");
  if (!attachMenu.contains(e.target as Node) && e.target !== attachBtn) attachMenu.classList.add("hidden");
});

function showRecap(text: string) {
  log.querySelector(".recap")?.remove();
  const r = el("div", "recap");
  r.append(el("span", "recap__mark", MARK.recap), el("span", "recap__label", "While you were away"), el("span", "recap__text", text));
  r.append(button("×", "icon small", () => r.remove(), "Dismiss"));
  log.append(r);
  log.scrollTop = log.scrollHeight;
}

const sendVisibility = () =>
  post({ type: "visible", visible: document.visibilityState === "visible", focused: document.hasFocus() });
document.addEventListener("visibilitychange", sendVisibility);
window.addEventListener("focus", sendVisibility);
window.addEventListener("blur", sendVisibility);

// --- From the host -----------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent<HostMessage | { type: "open-history" }>) => {
  const m = e.data;
  switch (m.type) {
    case "status":
      if (m.status === "starting") setNotice("Starting Atlarix…");
      else if (m.status === "ready") setNotice(null);
      else if (m.status === "signed-out") setNotice("Sign in to Atlarix to start.", [["Sign in", () => post({ type: "sign-in" })]]);
      else if (m.status === "no-folder") setNotice("Open a folder to work in, then start a chat.");
      else setNotice(`Atlarix couldn't start: ${m.detail ?? "unknown error"}`, [["Show log", () => post({ type: "show-log" })], ["Retry", () => post({ type: "new-chat" })]]);
      return;
    case "session":
      if (m.replay || m.sessionId !== shownSession) {
        shownSession = m.sessionId;
        tools.clear();
        perms.clear();
        current = null;
        planBox.classList.add("hidden");
        showEmpty();
        titleEl.textContent = m.title ?? (m.replay ? pendingTitle : null) ?? "New chat";
        pendingTitle = null;
        status.textContent = "";
      }
      if (m.modes) {
        mode = m.modes.currentModeId;
        if (!m.configOptions.length) {
          modeSel.textContent = "";
          for (const x of m.modes.availableModes) {
            const op = el("option", "", x.name);
            op.value = x.id;
            modeSel.append(op);
          }
          modeSel.value = mode;
          fitSelect(modeSel);
        }
      }
      if (m.configOptions.length) setOptions(m.configOptions);
      return;
    case "update":
      return onUpdate(m.update);
    case "permission":
      return showPermission(m.requestId, m.toolCall, m.options, m.hasDiff);
    case "permission-done": {
      const card = perms.get(m.requestId);
      card?.classList.add("answered");
      card?.querySelectorAll("button").forEach((b) => b.setAttribute("disabled", ""));
      perms.delete(m.requestId);
      return;
    }
    case "turn-start":
      current = null;
      setBusy(true);
      return;
    case "turn-end":
      current = null;
      setBusy(false);
      if (m.error) {
        const err = el("div", "error", m.error);
        log.append(err);
        scrollDown();
      }
      return;
    case "sessions":
      return showHistory(m.sessions);
    case "open-history":
      return post({ type: "history" });
    case "add-context":
      context.push(m.item);
      renderChips();
      input.focus();
      return;
    case "chrome":
      chromeDot.classList.toggle("on", !/not connected|unavailable/i.test(m.status));
      chromeDot.title = `Chrome: ${m.status}`;
      return;
    case "recap":
      return showRecap(m.text);
    case "recap-setting":
      recapOn = m.on;
      recapItem.textContent = `Session recap: ${recapOn ? "on" : "off"}`;
      return;
    case "host-info":
      for (const b of tabButtons) b.classList.toggle("hidden", m.where !== "tab");
      return;
  }
});

showEmpty();
post({ type: "ready" });
