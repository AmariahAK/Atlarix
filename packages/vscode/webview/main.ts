/**
 * The chat, drawn in the editor's webview: Rix's navbar (New chat, Past chats,
 * MCP, Account, Settings), the task card and conversation, the composer, and
 * pages over them (history, account, MCP, settings and Models & keys).
 *
 * Vanilla DOM, like the Chrome side panel, and the same rule: model output
 * never goes through innerHTML (the markdown renderer builds nodes). The only
 * markup set as HTML is our own SVG.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import * as S from "./chat/suggestions";
import type { HostMessage } from "../src/protocol";
import * as C from "./chat/composer";
import { closePicker, initPicker, picker, renderPicker } from "./chat/picker";
import { clearTask, renderTask, setPlan, taskCard, readyPlanTitle } from "./chat/task";
import { resetTasks, tasksBar, tasksChanged } from "./chat/tasks";
import * as T from "./chat/transcript";
import { onHost, post, rpc } from "./rpc";
import { applyOptions, emit, loadProviders, on, state } from "./state";
import { button, el, iconButton, MODE_NAME, relTime, rixGlyph } from "./ui";
import { renderAccount } from "./views/account";
import { renderAddProvider } from "./views/addProvider";
import { historyChanged, leaveHistory, renderHistory, renderUndo } from "./views/history";
import { clearRating, maybeAskRating } from "./chat/rating";
import { renderAutomations } from "./views/automations";
import { renderMcp } from "./views/mcp";
import type { Nav, View } from "./views/nav";
import { renderProvider } from "./views/provider";
import { renderSettings } from "./views/settings";

// --- Layout ---------------------------------------------------------------------

const app = document.getElementById("app")!;
const nav = el("header", "nav");
// Runs finished since you last opened Automations: a count on its button.
let automationUnread = 0;
const automationsButton = iconButton("bolt", "Automations", () => go({ name: "automations" }));
const automationsBadge = el("span", "nav__count hidden");
automationsButton.append(automationsBadge);
function setAutomationUnread(n: number): void {
  automationUnread = n;
  automationsBadge.textContent = n > 9 ? "9+" : String(n);
  automationsBadge.classList.toggle("hidden", n === 0);
}
const brand = el("div", "nav__brand");
brand.innerHTML = rixGlyph(20);
brand.append(el("span", "nav__name", "Atlarix"), el("span", "needs-badge", "Needs you"));
nav.append(
  brand,
  iconButton("plus", "New chat", () => {
    go({ name: "chat" });
    C.expectSession();
    post({ type: "new-chat" });
  }),
  iconButton("history", "Past chats", () => go({ name: "history" })),
  iconButton("server", "MCP servers", () => go({ name: "mcp" })),
  automationsButton,
  iconButton("user", "Account", () => go({ name: "account" })),
  iconButton("gear", "Settings", () => go({ name: "settings" })),
);
const notice = el("div", "notice hidden");
const chat = el("div", "chat");
chat.append(taskCard, T.log);
const page = el("div", "page hidden");
const toastSlot = el("div", "toast-slot");
app.append(nav, notice, chat, C.composer, page, picker, toastSlot);
// What is still running sits just above the message box, where you are looking.
C.composer.prepend(tasksBar);

// --- Screens ---------------------------------------------------------------------

const stack: View[] = [];

const navApi: Nav = {
  go: (v) => go(v),
  back: () => {
    stack.pop();
    const prev = stack.pop();
    go(prev ?? { name: "chat" });
  },
};

function go(v: View): void {
  closePicker();
  leaveHistory();
  if (v.name === "chat") {
    stack.length = 0;
    page.classList.add("hidden");
    page.textContent = "";
    C.focusInput();
    return;
  }
  // The page already on top is drawn again, not stacked twice: Back would show it again.
  if (stack.at(-1)?.name === v.name) stack[stack.length - 1] = v;
  else stack.push(v);
  page.classList.remove("hidden");
  page.scrollTop = 0;
  if (v.name === "history") void renderHistory(page, navApi);
  else if (v.name === "undo") void renderUndo(page, navApi, (id, text) => void C.goBack(id, text, null));
  else if (v.name === "account") void renderAccount(page, navApi);
  else if (v.name === "mcp") void renderMcp(page, navApi);
  else if (v.name === "automations") void renderAutomations(page, navApi, () => setAutomationUnread(0));
  else if (v.name === "settings") renderSettings(page, navApi, v.tab);
  else if (v.name === "provider") void renderProvider(page, navApi, v.id);
  else if (v.name === "add-provider") void renderAddProvider(page, navApi, v.focus);
}

initPicker((providerId) => (providerId ? go({ name: "provider", id: providerId }) : go({ name: "settings", tab: "keys" })));
T.initTranscript({
  goBack: (id, text, restore) => void C.goBack(id, text, restore),
  answer: (text, answers) => C.sendText(text, [], answers),
  restore: (id, text, anchor) => C.restoreAt(id, text, anchor),
});
C.initComposer({
  open: (v) => (v === "approve" ? go({ name: "settings", tab: "approve" }) : v === "keys" ? go({ name: "settings", tab: "keys" }) : go({ name: v })),
});
window.addEventListener("atlarix-approve-changed", () => void C.refreshApproveLine());

// --- Home: Rix, one line, and your recent chats ------------------------------------------

async function showHome(): Promise<void> {
  if (!T.isEmpty() || T.log.querySelector(".home")) return;
  const home = el("div", "home");
  const big = el("div", "home__rix");
  big.innerHTML = rixGlyph(96);
  home.append(big, el("h1", "home__title", "What are we building?"));
  T.log.append(home);
  const r = await rpc<{ sessions: Array<{ sessionId: string; title: string | null; updatedAt: string; mode: string | null }> }>("_atlarix/sessions", {
    cwd: state.workspace,
  }).catch(() => ({ sessions: [] }));
  const recent = r.sessions.filter((s) => s.sessionId !== state.sessionId && s.title && !/^untitled$/i.test(s.title)).slice(0, 3);
  if (!recent.length || !home.isConnected) return;
  const sec = el("section", "home__recent");
  const head = el("div", "row between");
  head.append(el("span", "eyebrow", "RECENT"), button("All chats", "link small", () => go({ name: "history" })));
  sec.append(head);
  for (const s of recent) {
    const b = button("", "recent", () => post({ type: "load-session", sessionId: s.sessionId }));
    b.append(el("span", "recent__title", s.title ?? "Untitled"), el("span", "recent__meta", [relTime(s.updatedAt), s.mode ? MODE_NAME[s.mode] : ""].filter(Boolean).join(" · ")));
    sec.append(b);
  }
  home.append(sec);
}

// --- Notices and toasts ----------------------------------------------------------------

function setNotice(text: string | null, actions: Array<[string, () => void]> = []): void {
  notice.textContent = "";
  notice.classList.toggle("hidden", !text);
  if (!text) return;
  notice.append(el("span", "grow", text));
  for (const [label, fn] of actions) notice.append(button(label, "small", fn));
}

function toast(text: string, tone: "info" | "error" = "info"): void {
  toastSlot.textContent = "";
  const t = el("div", `toast ${tone}`, text);
  t.setAttribute("role", "status");
  toastSlot.append(t);
  setTimeout(() => t.remove(), 6000);
}

// --- What the agent sends -----------------------------------------------------------------

let replaying = false;
let slowStart: ReturnType<typeof setTimeout> | undefined;

function onUpdate(u: SessionUpdate): void {
  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      const q = (u as { _meta?: { atlarix?: { question?: { items: Array<{ question: string; options?: string[] }> } } } })._meta?.atlarix?.question;
      if (q) return T.showQuestion(q.items);
      if (u.content.type === "text") T.appendText("reply", u.content.text, replaying);
      return;
    }
    case "agent_thought_chunk":
      if (u.content.type === "text") T.appendText("thought", u.content.text, replaying);
      return;
    case "user_message_chunk": {
      const meta = (u as { _meta?: { atlarix?: { messageId?: number; echo?: boolean } } })._meta?.atlarix;
      // An echo names the message already drawn and draws nothing, unless that
      // one is named already: then it is a message sent while the turn ran (a
      // steer, or one queued for after), which has no bubble yet (QA F2).
      if (meta?.echo && meta.messageId != null) {
        if (T.lastUserAwaitsId()) return T.tagLastUser(meta.messageId);
        if (u.content.type === "text") T.addUser(u.content.text, [], meta.messageId);
        return;
      }
      if (u.content.type === "text") T.addUser(u.content.text, [], meta?.messageId);
      return;
    }
    case "tool_call":
    case "tool_call_update":
      T.toolCall(u as Parameters<typeof T.toolCall>[0]);
      C.noteStep((u as { title?: string }).title, u.status);
      return;
    case "plan":
      setPlan(u as Parameters<typeof setPlan>[0]);
      return;
    case "current_mode_update":
      state.mode = u.currentModeId;
      emit("options");
      return;
    case "config_option_update":
      applyOptions(u.configOptions);
      renderPicker();
      return;
    case "usage_update": {
      const meta = (u as { _meta?: { atlarix?: { tokens?: number; cachedTokens?: number } } })._meta?.atlarix;
      state.usage = {
        tokens: meta?.tokens ?? state.usage.tokens,
        cachedTokens: meta?.cachedTokens ?? state.usage.cachedTokens,
        cost: (u as { cost?: { amount: number } }).cost?.amount ?? state.usage.cost,
        used: u.used,
        size: u.size,
      };
      emit("usage");
      return;
    }
    case "session_info_update":
      if (u.title) {
        state.title = u.title;
        renderTask();
      }
      return;
    case "available_commands_update":
      state.commands = u.availableCommands.map((c) => ({ name: c.name, description: c.description }));
      return;
    default:
      return;
  }
}

/** Out of free share or credit, or a key that stopped working: the way on is right here. */
function turnError(text: string): void {
  const actions = /free share|insufficient.credit|add credit|out of credit|balance|free usage/i.test(text)
    ? [
        button("Add credit", "primary small", () => post({ type: "checkout", kind: "credit" })),
        button("Get Pro", "small", () => post({ type: "checkout", kind: "pro" })),
        button("Use your own key", "link small", () => go({ name: "settings", tab: "keys" })),
      ]
    : /api key|rejected|unauthori[sz]ed|\b401\b/i.test(text)
      ? [button("Models & keys", "small", () => go({ name: "settings", tab: "keys" }))]
      : [];
  T.showError(text, actions);
}

onHost((m: HostMessage) => {
  switch (m.type) {
    case "status":
      state.signedIn = m.status === "signed-out" ? false : m.status === "ready" ? true : state.signedIn;
      clearTimeout(slowStart);
      if (m.status === "starting") {
        setNotice("Starting Atlarix…");
        // A first start can be slow (Windows on ARM runs the agent emulated:
        // ~40s of an unchanging line looked stuck, QA).
        slowStart = setTimeout(() => setNotice("Starting Atlarix… The first start on this computer can take up to a minute."), 6_000);
      } else if (m.status === "ready") setNotice(null);
      else if (m.status === "signed-out") setNotice("Sign in to Atlarix to start.", [["Sign in", () => post({ type: "sign-in" })]]);
      else if (m.status === "no-folder") setNotice("Open a folder to work in, then start a chat.");
      else setNotice(`Atlarix couldn't start: ${m.detail ?? "unknown error"}`, [["Show log", () => post({ type: "show-log" })], ["Retry", () => (C.expectSession(), post({ type: "new-chat" }))]]);
      // Signed out or back in while Account is open: draw it again. It kept
      // your email and credit after Sign out, so it looked like nothing
      // happened (owner).
      if ((m.status === "signed-out" || m.status === "ready") && stack.at(-1)?.name === "account") void renderAccount(page, navApi);
      return;
    case "session":
      if (m.replay || m.sessionId !== state.sessionId) {
        state.sessionId = m.sessionId;
        state.title = m.title ?? "New chat";
        state.usage = { tokens: 0, cachedTokens: 0, cost: 0, used: 0, size: 0 };
        T.resetTranscript();
        clearTask();
        resetTasks();
        clearRating();
        emit("session");
        // The new chat's ring starts empty, not the last chat's (QA).
        emit("usage");
      }
      // A replay just finished: fold its finished turns as a live turn folds.
      const replayed = replaying && !m.replay && m.sessionId === state.sessionId;
      if (replayed) T.foldReplayedTurns();
      replaying = m.replay;
      if (m.configOptions.length) applyOptions(m.configOptions);
      else if (m.modes) {
        state.mode = m.modes.currentModeId;
        state.modes = m.modes.availableModes.map((x) => ({ value: x.id, name: x.name, description: x.description }));
        emit("options");
      }
      if (!m.replay) {
        // After a replay its last reply stays open: a turn still running in
        // the CLI carries on in it, not in a second reply (QA E14).
        if (!replayed) T.endTurn();
        void showHome();
        void C.refreshApproveLine();
        C.sessionArrived();
      }
      return;
    case "update":
      return onUpdate(m.update);
    case "permission":
      C.addApproval({ requestId: m.requestId, toolCall: m.toolCall, options: m.options, hasDiff: m.hasDiff });
      return;
    case "permission-done":
      C.approvalDone(m.requestId);
      return;
    case "turn-start":
      C.setBusy(true);
      T.beginTurn();
      return;
    case "tasks-changed":
      tasksChanged(m.count);
      return;
    case "sessions-changed":
      historyChanged();
      return;
    case "pending":
      return C.showPending(m.items);
    case "mcp-suggestion":
      if (m.card.resolved) return S.removeSuggestion(String(m.card.id));
      return S.showSuggestion(m.card as unknown as S.SuggestionCard);
    case "working":
      if (typeof m.following === "boolean") return C.setFollowing(m.following, m.title ?? null);
      return C.setWorkingNote(m.title ?? null);
    case "unsent":
      return C.restoreUnsent(m.text);
    case "turn-end": {
      C.setBusy(false);
      T.endTurn(m.stopReason === "cancelled");
      if (m.error) turnError(m.error);
      renderTask();
      const ready = m.stopReason === "cancelled" || m.error ? null : readyPlanTitle();
      if (ready) T.showPlanReady(ready.title, ready.resume, () => window.dispatchEvent(new CustomEvent("atlarix-build")));
      else T.clearPlanReady();
      if (!m.error && m.stopReason !== "cancelled" && !ready) void maybeAskRating();
      return;
    }
    case "add-context":
      C.addContext(m.item);
      return;
    case "chrome":
      state.chrome = m.status;
      C.setChrome(m.status);
      return;
    case "recap":
      return T.showRecap(m.text);
    case "recap-setting":
      state.recapOn = m.on;
      return;
    case "host-info":
      state.where = m.where;
      state.workspace = m.workspace;
      state.settings = m.settings;
      emit("settings");
      return;
    case "host-settings":
      state.settings = m.settings;
      emit("settings");
      return;
    case "toast":
      return toast(m.text, m.tone);
    case "automation-run": {
      const what = (m.summary ?? (m.status === "nothing-to-report" ? "nothing to report" : "done")).split("\n")[0];
      // Open on the page already: draw it again with the new run.
      if (stack.at(-1)?.name === "automations") void renderAutomations(page, navApi, () => setAutomationUnread(0));
      else setAutomationUnread(automationUnread + 1);
      return toast(`Automation “${m.name}” · ${what}`, m.status === "error" ? "error" : "info");
    }
    case "open":
      if (m.what === "model-picker") {
        go({ name: "chat" });
        return C.togglePicker();
      }
      if (m.what === "keys") return go({ name: "settings", tab: "keys" });
      if (m.what === "approve") return go({ name: "settings", tab: "approve" });
      return go({ name: m.what });
    case "files":
      return C.showFiles(m.query, m.files);
    case "active-file":
      return C.setActiveFile(m.item);
  }
});

// Rejected keys hide their models in the picker: know which, early. And the Plan model.
on("session", () => void loadProviders().catch(() => {}));
on("session", () => void rpc<{ model: string | null }>("_atlarix/plan_model").then((r) => (state.planModel = r.model)).catch(() => {}));
on("keys", renderPicker);

const sendVisibility = () => post({ type: "visible", visible: document.visibilityState === "visible", focused: document.hasFocus() });
document.addEventListener("visibilitychange", sendVisibility);
window.addEventListener("focus", sendVisibility);
window.addEventListener("blur", sendVisibility);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !page.classList.contains("hidden") && !(e.target as HTMLElement).closest("input,textarea,select")) navApi.back();
});

// A reload or a closed panel never leaves Past chats the usual way: stop its watch.
window.addEventListener("pagehide", () => leaveHistory());

post({ type: "ready" });
