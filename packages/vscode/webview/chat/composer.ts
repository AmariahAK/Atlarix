/**
 * Everything under the conversation: an approval waiting for you (its buttons
 * above the box, as Cline puts them), what Atlarix is doing right now, the
 * box itself (chips, @ and / menus, paste and drop, the mode, send/stop), the
 * model under it, and Chrome.
 */
import type { PermissionOption, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { ContextItem } from "../../src/protocol";
import { filterCommands, mentionAt, recordsAnswer, slashQuery } from "../logic";
import { post, rpc } from "../rpc";
import { modelName, on, state } from "../state";
import { button, el, icon, iconButton, MODE_NAME, tokens } from "../ui";
import { closePicker, openPicker, picker, pickerOpen } from "./picker";
import * as T from "./transcript";
import { suggestionsBox } from "./suggestions";
import { ratingBox } from "./rating";
import { DROP_HINT, droppedFileKind } from "./drop";
import { keptFilesLine } from "../../../../src/lib/chat/kept-files-line";

export interface ComposerHooks {
  open(view: "mcp" | "approve" | "keys" | "undo" | "automations"): void;
}
let hooks: ComposerHooks;

export const composer = el("footer", "composer");

const approval = el("section", "approval hidden");
approval.setAttribute("aria-label", "Waiting for you");
const working = el("div", "working hidden");
const editBar = el("div", "edit-bar hidden");
const suggest = el("div", "suggest hidden");
const modeMenu = el("div", "menu mode-menu hidden");
const box = el("div", "box");
// VS Code only passes a drag into a webview while Shift is held (drop.ts).
box.title = DROP_HINT;
const chips = el("div", "chips");
const input = el("textarea", "input");
input.rows = 2;
/** What the empty box invites, by mode: "build, fix" read wrong in Plan or Explore (QA). */
function idlePlaceholder(): string {
  if (state.mode === "plan") return "Describe what to plan…";
  if (state.mode === "ask") return "Ask about the code…";
  return "Ask Atlarix to build, fix or explain…";
}
input.placeholder = idlePlaceholder();
input.setAttribute("aria-label", "Message");
const bar = el("div", "box__bar");
// The mode waits while another surface runs the turn (the agent would refuse it).
const modePill = button("", "pill mode-pill", () => following || modeMenu.classList.toggle("hidden"), "Mode");
// While it works the button stops it; Enter in the box steers instead.
const sendBtn = button("", "send", () => (state.busy ? post({ type: "cancel" }) : submit()), "Send");
/** What you sent while it worked, still waiting: steers and queued messages. */
const pendingList = el("div", "waiting hidden");
const approveLine = button("", "approve-line", () => hooks.open("approve"));
const under = el("div", "under");
const modelBtn = button("", "model-btn", () => togglePicker(), "Model");
const chromeDot = el("span", "chrome");
const ctxRing = el("span", "ctx-ring hidden");
ctxRing.setAttribute("role", "img");

let context: ContextItem[] = [];
let activeFile: ContextItem | null = null;
let activeDismissed: string | null = null;
let editing: { messageId: number; restore: boolean } | null = null;
const approvals: Array<{ requestId: string; toolCall: ToolCallUpdate & { _meta?: unknown }; options: PermissionOption[]; hasDiff: boolean }> = [];
let workingSince = 0;
let workingTitle = "";
let workingTimer: ReturnType<typeof setInterval> | null = null;

export function initComposer(h: ComposerHooks): void {
  hooks = h;
  bar.append(
    iconButton("at", "Add context (@)", () => toggleMentions()),
    iconButton("image", "Add an image", () => post({ type: "pick-image" })),
    iconButton("server", "MCP servers", () => hooks.open("mcp")),
    el("span", "grow"),
    modePill,
    sendBtn,
  );
  box.append(chips, input, bar);
  under.append(modelBtn, ctxRing, el("span", "grow"), chromeDot);
  on("usage", renderContext);
  composer.append(approval, working, editBar, suggest, modeMenu, approveLine, pendingList, suggestionsBox, ratingBox, box, under);
  setBusy(false);
  renderOptions();
  on("options", renderOptions);
  on("settings", () => (sendBtn.title = sendTitle()));
  on("session", () => {
    endEdit();
    void refreshApproveLine();
    // Another session now: it says for itself whether it runs elsewhere.
    if (following) setFollowing(false, null);
  });
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!picker.contains(t) && !modelBtn.contains(t)) closePicker();
    if (!modeMenu.contains(t) && !modePill.contains(t)) modeMenu.classList.add("hidden");
    if (!suggest.contains(t) && !box.contains(t)) closeSuggest();
  });
  window.addEventListener("atlarix-send", (e) => sendText((e as CustomEvent<string>).detail, []));
  window.addEventListener("atlarix-build", () => {
    if (state.busy) return;
    setBusy(true);
    post({ type: "build" });
  });
}

const sendTitle = () => (state.settings.ctrlEnterSends ? "Send (Ctrl+Enter)" : "Send (Enter)");

export function focusInput(): void {
  input.focus();
}

// --- Busy, mode, model --------------------------------------------------------------

export function setBusy(b: boolean): void {
  state.busy = b;
  sendBtn.innerHTML = b ? '<span class="stop-square"></span>' : icon("up", 15);
  sendBtn.title = b ? "Stop (Esc)" : sendTitle();
  sendBtn.setAttribute("aria-label", sendBtn.title);
  sendBtn.classList.toggle("stop", b);
  sendBtn.dataset.state = b ? "busy" : "idle";
  input.placeholder = b ? "Steer it (Enter) · Tab queues for after" : editing ? "Edit your message…" : idlePlaceholder();
  if (!b) showPending([]);
  workingNote = null;
  if (b) {
    workingSince = Date.now();
    workingTitle = "Thinking";
    if (!workingTimer) workingTimer = setInterval(renderWorking, 1000);
  } else if (workingTimer) {
    clearInterval(workingTimer);
    workingTimer = null;
  }
  renderWorking();
}

/** Shown instead of the step title while set ("Couldn't connect, retrying in 2s (1/3)…"). */
let workingNote: string | null = null;

/**
 * Another surface (the CLI, the app) runs this session's turn: the panel shows
 * it working, "Running in the CLI". Enter steers that turn and Stop stops it
 * (the agent sends both there). When it ends, the panel is idle again.
 */
let following = false;

export function setFollowing(on: boolean, title: string | null): void {
  if (on && !state.busy) {
    following = true;
    setBusy(true);
  } else if (!on && following) {
    following = false;
    setBusy(false);
  }
  modePill.title = following && title ? `${title} — wait for it to finish.` : "Mode";
  if (on) setWorkingNote(title);
}

export function setWorkingNote(note: string | null): void {
  workingNote = note;
  renderWorking();
}

/** A stopped turn's text the agent never got: back in the box, ahead of anything typed since. */
export function restoreUnsent(text: string): void {
  const now = input.value.trim();
  input.value = now ? `${text}\n${now}` : text;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

/** What Atlarix is doing now, from the step in progress. */
export function noteStep(title: string | null | undefined, status: string | null | undefined): void {
  if (title && (status === "in_progress" || status === "pending")) workingTitle = title;
  renderWorking();
}

function renderWorking(): void {
  working.classList.toggle("hidden", !state.busy || approvals.length > 0);
  if (!state.busy) return;
  working.textContent = "";
  const secs = Math.floor((Date.now() - workingSince) / 1000);
  const spin = el("span", "spinner");
  spin.setAttribute("aria-hidden", "true");
  working.append(spin, el("span", "working__title", workingNote ?? workingTitle), el("span", "grow"), el("span", "muted mono", `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`));
}

function renderOptions(): void {
  if (!state.busy && !editing) input.placeholder = idlePlaceholder();
  modePill.textContent = "";
  modePill.append(el("span", "", MODE_NAME[state.mode] ?? state.mode));
  modePill.insertAdjacentHTML("beforeend", icon("down", 10));
  modePill.classList.toggle("hidden", !state.modes.length);
  modeMenu.textContent = "";
  for (const m of state.modes) {
    const item = button("", `menu__item${m.value === state.mode ? " current" : ""}`, () => {
      modeMenu.classList.add("hidden");
      state.mode = m.value;
      renderOptions();
      post({ type: "set-option", configId: "mode", value: m.value });
    });
    item.append(el("span", "menu__label", m.name));
    if (m.description) item.append(el("span", "menu__desc", m.description));
    modeMenu.append(item);
  }
  modelBtn.textContent = "";
  modelBtn.classList.toggle("hidden", !state.modelGroups.length);
  // The effort beside the model only when it isn't the model's default ("· xhigh").
  const effort = state.thinking?.options.find((o) => o.value === state.thinking?.value);
  // The name gives way first in a narrow panel; the level beside it stays (QA).
  modelBtn.append(el("span", "model-btn__name", modelName()), ...(effort && effort.description !== "default" ? [el("span", "muted model-btn__level", `· ${effort.value}`)] : []));
  modelBtn.insertAdjacentHTML("beforeend", icon("chevUp", 10));
}

export function togglePicker(): void {
  if (pickerOpen()) return closePicker();
  closeSuggest();
  openPicker({
    current: state.modelValue,
    full: true,
    onChoose: (value) => {
      if (value === state.modelValue) return;
      state.modelValue = value;
      renderOptions();
      post({ type: "set-option", configId: "model", value });
      input.focus();
    },
  });
}

export function setChrome(status: string): void {
  const connected = !/not connected|unavailable/i.test(status);
  chromeDot.textContent = "";
  chromeDot.classList.toggle("on", connected);
  chromeDot.title = `Chrome: ${status}`;
  chromeDot.append(el("span", "dot"), el("span", "", "Chrome"));
}

/** The line above the box: whether edits ask first (Settings › Auto-approve). */
/**
 * How full the context is: a ring beside the model and its percentage, as the
 * app draws it (TokenCircle: green, amber from 65%, red from 85%). The chat's
 * tokens, cache and cost are in its tooltip.
 */
export function renderContext(): void {
  const u = state.usage;
  ctxRing.classList.toggle("hidden", !(u.size > 0));
  if (!(u.size > 0)) return;
  const pct = Math.min(1, Math.max(0, u.used / u.size));
  const size = 14;
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const tone = pct >= 0.85 ? "var(--danger)" : pct >= 0.65 ? "var(--warn)" : "var(--primary)";
  ctxRing.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="2"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${tone}" stroke-width="2" stroke-linecap="round" ` +
    `stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
  ctxRing.append(el("span", "", `${Math.round(pct * 100)}%`));
  const lines = [`Context ${tokens(u.used)} of ${tokens(u.size)}`];
  if (u.tokens > 0) lines.push(`${tokens(u.tokens)} tokens this chat${u.cachedTokens > 0 ? `, ${tokens(u.cachedTokens)} from cache` : ""}`);
  if (u.cost > 0) lines.push(`$${u.cost.toFixed(u.cost < 1 ? 3 : 2)} on your keys`);
  ctxRing.title = lines.join("\n");
  ctxRing.setAttribute("aria-label", `Context ${Math.round(pct * 100)}% full`);
}

export async function refreshApproveLine(): Promise<void> {
  if (!state.sessionId) return;
  const r = await rpc<{ folderEdits: boolean; rules: unknown[] }>("_atlarix/permissions", { sessionId: state.sessionId, action: "list" }).catch(() => null);
  approveLine.textContent = "";
  approveLine.classList.toggle("hidden", !r);
  if (!r) return;
  approveLine.append(
    el("span", "approve-line__k", "Auto-approve:"),
    el("span", "", r.folderEdits ? "edits in this folder, safe commands" : "safe commands · edits ask first"),
  );
  approveLine.insertAdjacentHTML("beforeend", icon("right", 11));
}

// --- Approvals ----------------------------------------------------------------------

export function addApproval(a: (typeof approvals)[number]): void {
  approvals.push(a);
  renderApproval();
}

export function approvalDone(requestId: string): void {
  const i = approvals.findIndex((a) => a.requestId === requestId);
  if (i >= 0) approvals.splice(i, 1);
  renderApproval();
}

/** Our labels for the agent's choices: "Run it" / "Apply", the "always" it offers, and "Don't". */
function optionLabel(o: PermissionOption, isCommand: boolean, isEdit: boolean): string {
  if (o.kind === "allow_once") return isCommand ? "Run it" : isEdit ? "Apply" : "Allow";
  if (o.kind.startsWith("reject")) return "Don't";
  const n = o.name.replace(/^yes,?\s*(and\s*)?/i, "");
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function renderApproval(): void {
  const a = approvals[0];
  approval.classList.toggle("hidden", !a);
  document.body.classList.toggle("needs-you", !!a);
  renderWorking();
  approval.textContent = "";
  if (!a) return;
  const meta = (a.toolCall._meta as {
    atlarix?: {
      approval?: {
        command?: string | null;
        path?: string | null;
        risky?: boolean;
        risk?: string | null;
        outside?: string | null;
        intent?: string | null;
        /** The agent's question for a command (approval-reason.ts): plain text, above the command. */
        reason?: string | null;
        /** An automation's when / each run / results lines. */
        details?: string[];
        added?: number | null;
        removed?: number | null;
      };
    };
  } | undefined)?.atlarix?.approval;
  const isCommand = !!meta?.command;
  const isEdit = !isCommand && !!meta?.path;
  // Free Atlarix Auto's consent: what is shared, with whom. It has to be READ
  // before it is given, so its words and its own buttons show (QA 15.7.1 #9).
  const isConsent = a.toolCall.toolCallId === "auto-consent";
  approval.classList.toggle("risky", !!meta?.risky);
  const head = el("div", "approval__head");
  const isAutomation = !!meta?.details?.length;
  head.innerHTML = icon(meta?.risky || isConsent ? "warn" : isCommand ? "terminal" : isAutomation ? "bolt" : isEdit ? "file" : "check", 15);
  const title = isCommand ? (meta?.risky ? "Run a risky command?" : "Run this command?") : isEdit ? "Apply this edit?" : (a.toolCall.title ?? "Atlarix wants to continue");
  head.append(el("span", "approval__title", title));
  if (approvals.length > 1) head.append(el("span", "muted small", `1 of ${approvals.length}`));
  approval.append(head);
  if (meta?.command && meta.reason) approval.append(el("div", "approval__reason", `Reason: ${meta.reason}`));
  if (meta?.command) approval.append(el("pre", "approval__code", meta.command));
  else if (meta?.path) {
    const row = el("div", "approval__code", meta.path);
    if (meta.added != null || meta.removed != null) {
      row.append(" ", el("span", "approval__add", `+${meta.added ?? 0}`), " ", el("span", "approval__del", `−${meta.removed ?? 0}`));
    }
    approval.append(row);
  }
  if (meta?.intent) approval.append(el("div", "approval__intent", meta.intent));
  for (const line of meta?.details ?? []) approval.append(el("div", "approval__detail", line));
  if (meta?.risk) approval.append(el("div", "approval__risk", meta.risk));
  if (meta?.outside) approval.append(el("div", "approval__risk", `Outside this folder: ${meta.outside}`));
  // A request with nothing of ours to draw (no command, file, intent or details)
  // shows the agent's own words: the consent's terms, an MCP tool's description.
  if (!isCommand && !isEdit && !meta?.intent && !meta?.details?.length) {
    for (const c of (a.toolCall.content ?? []) as Array<{ type?: string; content?: { type?: string; text?: string } }>) {
      if (c.type !== "content" || c.content?.type !== "text" || !c.content.text) continue;
      for (const para of c.content.text.split(/\n{2,}/)) if (para.trim()) approval.append(el("div", "approval__detail", para.trim()));
    }
  }
  const acts = el("div", "approval__acts");
  if (a.hasDiff) acts.append(button("View diff", "link small", () => post({ type: "open-diff", requestId: a.requestId })));
  for (const o of a.options) {
    const cls = o.kind.startsWith("reject") ? "deny" : o.kind === "allow_once" ? "primary" : "";
    const label = isConsent ? o.name : optionLabel(o, isCommand, isEdit);
    acts.append(
      button(label, cls, () => {
        post({ type: "permission", requestId: a.requestId, optionId: o.optionId });
        const denied = o.kind.startsWith("reject");
        if (recordsAnswer(meta, a.toolCall.toolCallId, denied)) {
          T.approvalRecord(meta?.command ? `$ ${meta.command}` : (meta?.path ?? a.toolCall.title ?? "Approval"), label, denied);
        }
        approvalDone(a.requestId);
      }),
    );
  }
  approval.append(acts);
}

// --- Going back to a message ------------------------------------------------------------

/**
 * A checkpoint's Restore: the files only (the chat stays as it is, the agent is
 * told), or the files and this message to edit and send again (QA E3; Cline's
 * "Restore Files" vs "Restore Files & Task", Claude Code's code-only rewind).
 */
export function restoreAt(messageId: number, text: string, anchor: HTMLElement): void {
  T.log.querySelector(".undo-choice")?.remove();
  const card = el("div", "card undo-choice");
  card.append(el("div", "card__title", "Restore to this checkpoint"), el("div", "muted small", "The files Atlarix changed after it go back to how they were."));
  const note = el("div", "muted small hidden");
  const acts = el("div", "card__options");
  acts.append(
    button("Files only", "primary", async () => {
      acts.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
      try {
        const r = await rpc<{ restoredFiles: number; kept?: string[] }>("_atlarix/undo", { sessionId: state.sessionId, action: "restore_files", messageId });
        card.remove();
        const kept = keptFilesLine(r.kept ?? []);
        T.addNote(`Restored ${r.restoredFiles} file${r.restoredFiles === 1 ? "" : "s"} to this checkpoint.${kept ? ` ${kept}.` : ""} The chat is unchanged; Atlarix is told with your next message.`);
      } catch (x) {
        note.textContent = (x as Error).message;
        note.classList.remove("hidden");
        acts.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = false));
      }
    }),
    button("Files and edit the message", "", () => {
      card.remove();
      beginEdit(messageId, text, true);
    }),
    button("Cancel", "link", () => card.remove()),
  );
  card.append(note, acts);
  anchor.after(card);
  card.scrollIntoView({ block: "nearest" });
}

/** Edit (restore: null asks if files changed), or a checkpoint's Restore (true). */
export async function goBack(messageId: number, text: string, restore: boolean | null): Promise<void> {
  if (restore === null) {
    const r = await rpc<{ filesChanged?: string[]; createdFiles?: string[] }>("_atlarix/undo", { sessionId: state.sessionId, action: "preview", messageId }).catch(
      () => ({}) as { filesChanged?: string[]; createdFiles?: string[] },
    );
    const files = [...(r.filesChanged ?? []), ...(r.createdFiles ?? [])];
    if (files.length) return chooseRestore(messageId, text, files);
  }
  beginEdit(messageId, text, restore === true);
}

function chooseRestore(messageId: number, text: string, files: string[]): void {
  T.log.querySelector(".undo-choice")?.remove();
  const card = el("div", "card undo-choice");
  const names = files.slice(0, 4).join(", ") + (files.length > 4 ? " …" : "");
  card.append(el("div", "card__title", `Atlarix changed ${files.length} file${files.length === 1 ? "" : "s"} after this message`), el("div", "muted small", names));
  const acts = el("div", "card__options");
  acts.append(
    button(`Restore ${files.length === 1 ? "it" : "them"}, then edit`, "primary", () => {
      card.remove();
      beginEdit(messageId, text, true);
    }),
    button("Keep the files, edit", "", () => {
      card.remove();
      beginEdit(messageId, text, false);
    }),
    button("Cancel", "link", () => card.remove()),
  );
  card.append(acts);
  const m = T.log.querySelector<HTMLElement>(`.msg.user[data-id="${messageId}"]`);
  if (m) m.after(card);
  else T.log.append(card);
  card.scrollIntoView({ block: "nearest" });
}

function beginEdit(messageId: number, text: string, restore: boolean): void {
  editing = { messageId, restore };
  input.value = text;
  editBar.textContent = "";
  editBar.append(
    el("span", "", restore ? "Editing an earlier message · its files go back when you send" : "Editing an earlier message · what came after it is replaced"),
    button("Cancel", "link small", () => {
      endEdit();
      input.value = "";
    }),
  );
  editBar.classList.remove("hidden");
  setBusy(state.busy);
  input.focus();
}

function endEdit(): void {
  editing = null;
  editBar.classList.add("hidden");
}

// --- Chips ------------------------------------------------------------------------------

export function setActiveFile(item: ContextItem | null): void {
  activeFile = item;
  renderChips();
}

export function addContext(item: ContextItem): void {
  if (!context.some((c) => c.path === item.path && c.label === item.label && c.startLine === item.startLine)) context.push(item);
  renderChips();
  input.focus();
}

/** The open file, unless removed or already attached. */
function offeredFile(): ContextItem | null {
  if (!state.settings.attachOpenFile || !activeFile || activeDismissed === activeFile.path) return null;
  return context.some((c) => c.path === activeFile!.path && c.startLine == null) ? null : activeFile;
}

function renderChips(): void {
  chips.textContent = "";
  const offered = offeredFile();
  if (offered) {
    const chip = el("span", "chip offered", offered.label.split(/[\\/]/).pop() ?? offered.label);
    chip.title = `${offered.label}: the open file, sent with your message`;
    chip.append(button("×", "chip__x", () => {
      activeDismissed = offered.path;
      renderChips();
    }, `Don't send ${offered.label}`));
    chips.append(chip);
  }
  context.forEach((c, i) => {
    const chip = el("span", "chip", c.folder ? c.label : (c.label.split(/[\\/]/).pop() ?? c.label));
    chip.title = c.label;
    chip.append(button("×", "chip__x", () => {
      context.splice(i, 1);
      renderChips();
    }, `Remove ${c.label}`));
    chips.append(chip);
  });
}

// --- Sending ------------------------------------------------------------------------------

// A New chat is on its way: what you send meanwhile waits for it. Drawn now, the
// bubble was wiped when the new chat arrived and reset the transcript (QA #55).
let awaitingSession = false;
let held: Array<() => void> = [];
let awaitTimer: ReturnType<typeof setTimeout> | undefined;

/** New chat asked for: hold sends until its session arrives (or 10s pass). */
export function expectSession(): void {
  awaitingSession = true;
  clearTimeout(awaitTimer);
  awaitTimer = setTimeout(sessionArrived, 10_000);
}

/** The new chat is here: send what was held, in order. */
export function sessionArrived(): void {
  if (!awaitingSession) return;
  awaitingSession = false;
  clearTimeout(awaitTimer);
  const sends = held;
  held = [];
  for (const send of sends) send();
}

export function sendText(text: string, items: ContextItem[], answers?: string[]): void {
  if (awaitingSession) {
    held.push(() => sendText(text, items, answers));
    return;
  }
  if (state.busy) return;
  T.addUser(text, items);
  setBusy(true);
  post({ type: "send", text, context: items, ...(answers ? { answers } : {}) });
}

/**
 * While a turn runs: Enter steers (the agent reads it at its next step), Tab
 * queues it for after the turn, as the CLI and Codex do. Esc or the button stops.
 */
function interject(kind: "steer" | "queue"): void {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  refreshSuggest();
  void rpc<{ started: boolean; wait?: string }>("_atlarix/interject", { sessionId: state.sessionId, text, kind })
    .then((r) => {
      if (r.started) return;
      // A command waits for the turn (it is never sent as text), and a message
      // whose turn ended but the panel has not heard yet would be dropped by
      // sendText: back in the box, either way (QA E10).
      if (r.wait || state.busy) {
        restoreUnsent(text);
        if (r.wait) setWorkingNote(r.wait);
        return;
      }
      // The turn ended just before it arrived: send it as the next message.
      sendText(text, []);
    })
    .catch(() => (input.value = text));
}

/** The list above the box: each waiting message and when it goes in. */
export function showPending(items: Array<{ id: string; text: string; kind: string }>): void {
  pendingList.textContent = "";
  pendingList.classList.toggle("hidden", !items.length);
  for (const p of items) {
    const row = el("div", "waiting__row");
    row.append(el("span", "waiting__text", p.text.split("\n")[0]!), el("span", "waiting__when", p.kind === "steer" ? "goes in after this step" : "sent when this turn ends"));
    pendingList.append(row);
  }
}

function submit(): void {
  if (state.busy) return interject("steer");
  const text = input.value.trim();
  if (editing) {
    if (!text) return;
    // Going back: the agent sends the conversation again from the top.
    const { messageId, restore } = editing;
    endEdit();
    T.resetTranscript();
    setBusy(true);
    post({ type: "undo-resend", messageId, text, restore });
    input.value = "";
    return;
  }
  if (text === "/undo") {
    input.value = "";
    return hooks.open("undo");
  }
  // This panel has a page for them; other editors get the list as a message.
  if (text === "/automations" || text === "/mcp") {
    input.value = "";
    return hooks.open(text === "/mcp" ? "mcp" : "automations");
  }
  if (!text && !context.length) return;
  const q = T.questionPending();
  if (q) {
    // Typed instead of using the card: that is the answer to every question.
    T.clearQuestion();
    sendText(text, [], q.map(() => text));
  } else {
    const offered = offeredFile();
    sendText(text, offered ? [offered, ...context] : context);
  }
  input.value = "";
  context = [];
  renderChips();
}

// --- The / and @ menus ------------------------------------------------------------------

let suggesting: { kind: "slash" } | { kind: "mention"; start: number; query: string } | { kind: "chips" } | null = null;
let suggestIndex = 0;
let filesTimer: ReturnType<typeof setTimeout> | null = null;

function closeSuggest(): void {
  suggesting = null;
  suggest.classList.add("hidden");
}

function suggestItems(): HTMLElement[] {
  return [...suggest.querySelectorAll<HTMLElement>(".suggest__item")];
}

function highlightSuggest(i: number): void {
  suggestItems().forEach((x, j) => x.classList.toggle("active", j === i));
  suggestItems()[i]?.scrollIntoView({ block: "nearest" });
}

/** The @ menu's shortcuts: things to add that aren't a file. */
function contextChips(): HTMLElement {
  const row = el("div", "suggest__chips");
  const chip = (name: string, label: string, run: () => void) => {
    const b = button("", "suggest__chip", () => {
      dropMention();
      closeSuggest();
      run();
    });
    b.innerHTML = icon(name, 12);
    b.append(document.createTextNode(` ${label}`));
    b.addEventListener("mousedown", (e) => e.preventDefault());
    row.append(b);
  };
  chip("warn", "Problems", () => post({ type: "add-problems" }));
  chip("terminal", "Terminal", () => post({ type: "add-terminal" }));
  chip("git", "Git changes", () => post({ type: "add-git", what: "changes" }));
  chip("git", "A commit…", () => post({ type: "add-git", what: "commit" }));
  chip("folder", "Folder…", () => post({ type: "pick-folder" }));
  chip("link", "URL", () => post({ type: "add-url" }));
  chip("file", "File…", () => post({ type: "pick-file" }));
  return row;
}

/** Remove the typed "@query" (it became a chip or a shortcut ran). */
function dropMention(): void {
  if (suggesting?.kind !== "mention") return;
  const at = suggesting;
  input.value = input.value.slice(0, at.start) + input.value.slice(at.start + 1 + at.query.length);
  input.selectionStart = input.selectionEnd = at.start;
}

function showSuggest(rows: Array<{ label: string | Node; detail?: string; pick: () => void }>, withChips = false): void {
  suggest.textContent = "";
  if (withChips) suggest.append(contextChips());
  for (const r of rows) {
    const b = button("", "suggest__item", r.pick);
    const l = el("span", "suggest__label");
    l.append(r.label);
    b.append(l);
    if (r.detail) b.append(el("span", "suggest__detail", r.detail));
    // Keep the focus in the box while choosing with the mouse.
    b.addEventListener("mousedown", (e) => e.preventDefault());
    suggest.append(b);
  }
  if (!rows.length && !withChips) return void suggest.classList.add("hidden");
  suggest.append(el("div", "suggest__hint", "↑↓ move · Enter choose · Esc close"));
  suggest.classList.remove("hidden");
  suggestIndex = 0;
  highlightSuggest(0);
}

/** The @ button: the shortcuts and the open files, as if @ had been typed. */
function toggleMentions(): void {
  if (!suggest.classList.contains("hidden")) return closeSuggest();
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const pad = before && !/\s$/.test(before) ? " " : "";
  input.value = `${before}${pad}@${input.value.slice(caret)}`;
  input.selectionStart = input.selectionEnd = caret + pad.length + 1;
  input.focus();
  refreshSuggest();
}

function refreshSuggest(): void {
  const caret = input.selectionStart ?? input.value.length;
  const slash = slashQuery(input.value);
  if (slash != null && state.commands.length) {
    suggesting = { kind: "slash" };
    return showSuggest(
      filterCommands(state.commands, slash).map((c) => ({
        label: `/${c.name}`,
        detail: c.description,
        pick: () => {
          closeSuggest();
          input.value = `/${c.name}`;
          // A skill takes what to do after it; the rest run as they are.
          if (/^Skill:/.test(c.description ?? "")) {
            input.value = `/${c.name} `;
            input.focus();
          } else submit();
        },
      })),
    );
  }
  const m = mentionAt(input.value, caret);
  if (m) {
    suggesting = { kind: "mention", ...m };
    if (filesTimer) clearTimeout(filesTimer);
    filesTimer = setTimeout(() => post({ type: "find-files", query: m.query }), 80);
    return;
  }
  closeSuggest();
}

/** The typed part of a file's name in bold. */
function highlighted(name: string, q: string): Node {
  const f = document.createDocumentFragment();
  const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    f.append(name);
    return f;
  }
  f.append(name.slice(0, i), el("strong", "hit", name.slice(i, i + q.length)), name.slice(i + q.length));
  return f;
}

export function showFiles(query: string, files: Array<{ path: string; label: string }>): void {
  if (suggesting?.kind !== "mention" || suggesting.query !== query) return;
  showSuggest(
    files.map((f) => ({
      label: highlighted(f.label.split(/[\\/]/).pop() ?? f.label, query),
      detail: f.label.includes("/") || f.label.includes("\\") ? f.label.replace(/[\\/][^\\/]*$/, "/") : "",
      pick: () => {
        dropMention();
        closeSuggest();
        addContext({ path: f.path, label: f.label });
      },
    })),
    true,
  );
}

input.addEventListener("input", () => refreshSuggest());

input.addEventListener("keydown", (e) => {
  if (suggesting && !suggest.classList.contains("hidden")) {
    const items = suggestItems();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      suggestIndex = Math.max(0, Math.min(items.length - 1, suggestIndex + (e.key === "ArrowDown" ? 1 : -1)));
      return highlightSuggest(suggestIndex);
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing && items[suggestIndex]) {
      e.preventDefault();
      return items[suggestIndex]!.click();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      return closeSuggest();
    }
  }
  const sendKey = state.settings.ctrlEnterSends ? e.key === "Enter" && (e.metaKey || e.ctrlKey) : e.key === "Enter" && !e.shiftKey;
  if (e.key === "Tab" && !e.shiftKey && state.busy && input.value.trim()) {
    e.preventDefault();
    interject("queue");
  } else if (sendKey && !e.isComposing) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape" && state.busy) post({ type: "cancel" });
  else if (e.key === "Escape" && editing) {
    endEdit();
    input.value = "";
  }
});

// --- Pasting and dropping ---------------------------------------------------------------

function readImage(file: File, label: string): void {
  const r = new FileReader();
  r.onload = () => {
    const data = String(r.result).split(",")[1] ?? "";
    addContext({ path: "", label, image: { data, mimeType: file.type || "image/png" } });
  };
  r.readAsDataURL(file);
}

input.addEventListener("paste", (e) => {
  const images = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === "file" && i.type.startsWith("image/"));
  if (!images.length) return;
  e.preventDefault();
  images.forEach((i, n) => {
    const f = i.getAsFile();
    if (f) readImage(f, images.length > 1 ? `Pasted image ${n + 1}` : "Pasted image");
  });
});

box.addEventListener("dragover", (e) => {
  e.preventDefault();
  box.classList.add("drop");
});
box.addEventListener("dragleave", () => box.classList.remove("drop"));
box.addEventListener("drop", (e) => {
  e.preventDefault();
  box.classList.remove("drop");
  const dt = e.dataTransfer;
  if (!dt) return;
  // Files from the editor's explorer arrive as URIs; images from the desktop as files.
  const uris = (dt.getData("text/uri-list") || dt.getData("application/vnd.code.uri-list") || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.startsWith("file://"));
  for (const u of uris) {
    const p = decodeURIComponent(new URL(u).pathname).replace(/^\/([a-zA-Z]:)/, "$1");
    addContext({ path: p, label: p.split(/[\\/]/).pop() ?? p });
  }
  if (!uris.length) for (const f of [...dt.files]) void addDroppedFile(f);
});

/** A file dropped from the desktop: an image, its text, or a notice saying why not (drop.ts). */
async function addDroppedFile(f: File): Promise<void> {
  const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
  const kind = droppedFileKind(f, head);
  if (kind === "image") return readImage(f, f.name);
  if (kind === "text") return addContext({ path: "", label: f.name, text: await f.text() });
  T.addNote(
    kind === "too-big"
      ? `${f.name} is too big to attach; drag it from the editor's explorer instead.`
      : `${f.name} isn't text; drag it from the editor's explorer instead.`,
  );
}
