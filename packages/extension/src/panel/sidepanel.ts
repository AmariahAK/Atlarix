/**
 * The side panel — the extension's UI, its agent loop, and the only context
 * with a user gesture.
 *
 * THREE THINGS HAPPEN HERE AND NOWHERE ELSE, for one underlying reason: this is
 * an ordinary document with an ordinary lifetime, and the service worker is not.
 *
 *   1. **Sign-in.** `chrome.identity.launchWebAuthFlow` holds one promise open
 *      while the user reads a consent screen. The worker dies after ~30s idle.
 *   2. **Host grants.** `chrome.permissions.request()` must be called from
 *      inside a user gesture and cannot be called from a service worker at all.
 *      A button click here is the gesture.
 *   3. **The agent loop.** Chrome terminates the worker when a `fetch()`
 *      response takes over 30 seconds, which is precisely what a streamed model
 *      turn is. See `agent/loop.ts` for why an offscreen document is not the
 *      answer either.
 *
 * (2) is a containment property worth stating plainly: the loop runs in this
 * document, but the only thing that can widen its reach is a button the USER
 * clicks. The loop can ask. It cannot grant.
 *
 * WHAT THE LOOP RUNNING HERE COSTS: closing the panel ends the turn. That is
 * said out loud in the UI rather than hidden, and softened by saving the
 * transcript after every round — so reopening shows everything up to the last
 * completed one.
 *
 * NO FRAMEWORK, and the DOM is built node by node. This package has no
 * dependencies and the content it renders is model output, which in this
 * product is downstream of web pages the agent read. `markdown.ts` carries the
 * full argument; the rule here is the same one: no `innerHTML`, anywhere.
 */

import {
  detectCapabilities,
  missingCapabilities,
  api,
} from "../shared/browser-api";
import { signIn, signOut } from "../auth/sign-in";
import { accountState } from "../auth/account";
import type { OAuthProvider } from "../auth/gotrue";
import {
  canActOn,
  pruneRevokedGrants,
  requestHostAccess,
  revokeHostAccess,
} from "../permissions/host-access";
import { listGrants, revokeAll } from "../permissions/site-grants";
import { activeTab } from "../page/inject";
import { onGroupClosed, setGroupTitle } from "../tabs/group";
import {
  CoreError,
  listModels,
  type CoreMessage,
  type ToolCall,
} from "../core/client";
import { runTurn } from "../agent/loop";
import { buildSystemPrompt } from "../agent/prompt";
import { forget, forgetAll, listMemories } from "../memory/store";
import {
  deleteAllSessions,
  deleteSession,
  listSessions,
  loadSession,
  newSessionId,
  pruneForModel,
  saveSession,
} from "../sessions/store";
import { renderMarkdown } from "./markdown";
import { chooseModel, optionsFor, shortModelName } from "./model-choice";

const MODEL_KEY = "atlarix.model.v1";

const el = <T extends HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`#${id}`);

const signedOut = el<HTMLElement>("signed-out");
const chat = el<HTMLElement>("chat");
const drawer = el<HTMLElement>("drawer");
const transcript = el<HTMLElement>("transcript");
const input = el<HTMLTextAreaElement>("composer-input");
const sendButton = el<HTMLButtonElement>("send");
const stopButton = el<HTMLButtonElement>("stop");
const modelSelect = el<HTMLSelectElement>("model-select");
const newChatButton = el<HTMLButtonElement>("new-chat");
const drawerButton = el<HTMLButtonElement>("toggle-drawer");
const accountEmail = el<HTMLElement>("account-email");
const signOutButton = el<HTMLButtonElement>("sign-out");
const accountChip = el<HTMLButtonElement>("account-chip");
const eraseButton = el<HTMLButtonElement>("erase-all");
const sessionList = el<HTMLElement>("session-list");
const siteList = el<HTMLElement>("site-list");
const memoryList = el<HTMLElement>("memory-list");
const status = el<HTMLElement>("status");
const providerButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-provider]"),
);

let sessionId = newSessionId();
let messages: CoreMessage[] = [];
let running: AbortController | null = null;

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

/* ── The transcript ───────────────────────────────────────────────────────── */

function atBottom(): boolean {
  if (!transcript) return true;
  // Within a line of the end. Sticking to the bottom only when the user is
  // ALREADY there is the difference between following a stream and being
  // yanked away from the paragraph you were reading.
  return (
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
    24
  );
}

function scrollDown(wasAtBottom: boolean): void {
  if (wasAtBottom && transcript) transcript.scrollTop = transcript.scrollHeight;
}

function append(node: HTMLElement): HTMLElement {
  const stick = atBottom();
  transcript?.append(node);
  scrollDown(stick);
  return node;
}

function userBubble(text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg msg--user";
  div.textContent = text;
  return div;
}

function assistantBubble(text = ""): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg msg--assistant";
  if (text) renderMarkdown(div, text);
  return div;
}

function errorBubble(text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg msg--error";
  div.textContent = text;
  return div;
}

/** One line per tool call: what it did, with the raw result behind a twisty. */
function toolChip(call: ToolCall): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "tool tool--running";
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "tool__dot";
  summary.append(dot, document.createTextNode(describeCall(call)));
  details.append(summary);
  return details;
}

function fillChip(details: HTMLDetailsElement, result: string): void {
  details.classList.remove("tool--running");
  const body = document.createElement("pre");
  body.className = "tool__body";
  body.textContent = result;
  details.append(body);
}

/**
 * A tool call in one short phrase.
 *
 * Says what it is doing TO WHAT — "Reading example.com", not "read_page". The
 * function name is the model's vocabulary and the URL is the user's, and the
 * line exists so the user can tell at a glance whether the agent is looking
 * somewhere they did not expect.
 */
function describeCall(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<
      string,
      unknown
    >;
  } catch {
    /* A half-streamed call. The name alone is still worth showing. */
  }
  const host = (value: unknown): string => {
    try {
      return new URL(String(value)).host;
    } catch {
      return String(value ?? "");
    }
  };
  switch (call.function.name) {
    case "read_page":
      return args.tab_id
        ? `Reading tab ${String(args.tab_id)}`
        : "Reading this page";
    case "find_on_page":
      return `Looking for “${String(args.query ?? "")}”`;
    case "list_tabs":
      return "Listing your tabs";
    case "open_tab":
      return `Opening ${host(args.url)}`;
    case "close_tab":
      return `Closing tab ${String(args.tab_id ?? "")}`;
    case "remember":
      return "Remembering something";
    default:
      return call.function.name;
  }
}

/**
 * The permission card, and the promise the loop is waiting on.
 *
 * `requestHostAccess` is called from INSIDE the click handler, synchronously,
 * because that is what makes it a user gesture — `permissions.request()` has no
 * other way to succeed, and it resolves FALSE on a decline rather than
 * rejecting, which is why `host-access.ts` orders the record after the answer.
 */
function grantCard(req: { url: string; origin: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const card = document.createElement("div");
    card.className = "grant";

    const title = document.createElement("div");
    title.className = "grant__origin";
    title.textContent = `Let Atlarix read ${req.origin}?`;

    const note = document.createElement("p");
    note.className = "grant__note";
    note.textContent =
      "Chrome will ask you to confirm. Atlarix can read this site until you " +
      "remove it, and nothing else.";

    const actions = document.createElement("div");
    actions.className = "grant__actions";

    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "button grant__allow";
    allow.textContent = "Allow";

    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "button";
    deny.textContent = "Not now";

    const settle = (answer: boolean, text: string) => {
      allow.remove();
      deny.remove();
      card.classList.add("grant--settled");
      title.textContent = text;
      note.remove();
      resolve(answer);
    };

    allow.addEventListener("click", () => {
      allow.disabled = true;
      deny.disabled = true;
      // Inside the gesture. Do NOT await anything before this call.
      void requestHostAccess(req.url).then((outcome) => {
        settle(
          outcome.ok,
          outcome.ok
            ? `Allowed ${req.origin}`
            : outcome.reason === "unsupported-scheme"
              ? `${req.origin} cannot be allowed — Atlarix only reads http(s) pages`
              : `Declined ${req.origin}`,
        );
      });
    });

    deny.addEventListener("click", () => {
      settle(false, `Declined ${req.origin}`);
    });

    actions.append(allow, deny);
    card.append(title, note, actions);
    append(card);
  });
}

/** Rebuild the whole transcript from a stored conversation. */
function renderConversation(history: CoreMessage[]): void {
  if (!transcript) return;
  transcript.textContent = "";

  if (history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const lede = document.createElement("strong");
    lede.textContent = "Ask about the page you are on.";
    empty.append(
      lede,
      document.createTextNode(
        "Atlarix reads the tabs you allow it to — no copying and pasting. " +
          "Keep this panel open while it works; closing it stops the answer.",
      ),
    );
    transcript.append(empty);
    return;
  }

  // Tool results are matched back to the call that produced them, so a reopened
  // conversation shows "Reading example.com" rather than a bare id.
  const callsById = new Map<string, ToolCall>();
  for (const message of history) {
    if (message.role === "assistant") {
      for (const c of message.tool_calls ?? []) callsById.set(c.id, c);
    }
  }

  for (const message of history) {
    if (message.role === "user") {
      transcript.append(userBubble(message.content));
    } else if (message.role === "assistant") {
      if (message.content) transcript.append(assistantBubble(message.content));
    } else if (message.role === "tool") {
      const call = callsById.get(message.tool_call_id);
      const chip = toolChip(
        call ?? {
          id: message.tool_call_id,
          type: "function",
          function: { name: "tool", arguments: "{}" },
        },
      );
      fillChip(chip, message.content);
      transcript.append(chip);
    }
  }
  transcript.scrollTop = transcript.scrollHeight;
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

function setRunning(isRunning: boolean): void {
  running = isRunning ? running : null;
  if (sendButton) sendButton.hidden = isRunning;
  if (stopButton) stopButton.hidden = !isRunning;
  if (newChatButton) newChatButton.disabled = isRunning;
  if (input) input.disabled = isRunning;
}

async function send(): Promise<void> {
  const text = input?.value.trim() ?? "";
  if (!text || running) return;

  const model = modelSelect?.value;
  if (!model) {
    // No id to send. Guessing one produces `model_not_permitted` on top of
    // whatever already stopped the lineup from loading.
    setStatus("No Atlarix Core model is available yet.");
    return;
  }

  if (input) {
    input.value = "";
    input.style.height = "auto";
  }
  // The empty state is a child of the transcript, so the first message has to
  // clear it rather than land underneath it.
  if (messages.length === 0) transcript?.replaceChildren();

  messages = [...messages, { role: "user", content: text }];
  append(userBubble(text));
  await persist();

  const controller = new AbortController();
  running = controller;
  setRunning(true);
  setStatus("");

  let windowId = api().windows.WINDOW_ID_NONE;
  try {
    const [memories, tab, win] = await Promise.all([
      listMemories(),
      activeTab(),
      currentWindowId(),
    ]);
    windowId = win;
    // The group's title is status where the user is already looking. It no-ops
    // until the agent has opened a tab, which is exactly when it starts to
    // matter: a group of tabs that says nothing about why it is there is the
    // thing people close in confusion.
    void setGroupTitle(windowId, "Atlarix · working");
    const system = buildSystemPrompt({
      memories,
      activeTab: tab
        ? {
            title: (await tabTitle(tab.id)) ?? "",
            url: tab.url,
            granted: await canActOn(tab.url),
          }
        : null,
    });

    let bubble: HTMLElement | null = null;
    let streamed = "";
    const chips = new Map<string, HTMLDetailsElement>();

    const outcome = await runTurn({
      model,
      system,
      // Pruned on the way OUT only. What is stored stays whole, so a
      // conversation the user scrolls back through is not missing the page
      // reads that a context limit made it cheaper not to re-send.
      messages: pruneForModel(messages),
      tools: { windowId },
      signal: controller.signal,
      events: {
        onText(delta) {
          streamed += delta;
          const stick = atBottom();
          if (!bubble) bubble = append(assistantBubble());
          renderMarkdown(bubble, streamed);
          scrollDown(stick);
        },
        onToolCall(call) {
          // A new assistant bubble after each tool round, so the transcript
          // reads in the order things happened rather than collecting all the
          // prose at the top.
          bubble = null;
          streamed = "";
          chips.set(call.id, append(toolChip(call)) as HTMLDetailsElement);
        },
        onToolResult(call, content) {
          const chip = chips.get(call.id);
          if (chip) fillChip(chip, content);
        },
        onGrantNeeded: grantCard,
      },
    });

    messages = [...messages, ...outcome.messages];
    await persist();

    if (outcome.kind === "error") {
      const { error } = outcome;
      if (error.status === 401 || error.code === "not_signed_in") {
        // Revoked elsewhere, or the refresh token spent by another context.
        void handleAuthLoss("Your session expired. Sign in again.");
        return;
      }
      append(errorBubble(describeError(error)));
    } else if (outcome.kind === "aborted") {
      setStatus("Stopped.");
    } else if (outcome.kind === "stuck") {
      setStatus("Atlarix stopped itself — it was repeating the same steps.");
    }
  } catch (err) {
    append(errorBubble(err instanceof Error ? err.message : String(err)));
  } finally {
    setRunning(false);
    void setGroupTitle(windowId, "Atlarix");
    void refreshDrawer();
  }
}

/**
 * An error the user can act on.
 *
 * `CoreError` already writes for a reader rather than a log, so this adds only
 * what the panel knows and the client cannot: where to go about credit.
 */
function describeError(error: CoreError): string {
  if (error.code === "insufficient_credit") {
    return `${error.message} Top up at atlarix.dev/account.`;
  }
  if (error.code === "not_signed_in" || error.status === 401) {
    return `${error.message} Open the menu and sign in again.`;
  }
  return error.message;
}

async function persist(): Promise<void> {
  try {
    await saveSession(sessionId, messages);
  } catch {
    // Storage full, most likely. Not worth ending a turn over, and the
    // conversation on screen is still the real one.
    setStatus("This conversation could not be saved to disk.");
  }
}

async function currentWindowId(): Promise<number> {
  const win = await api().windows.getCurrent();
  return win.id ?? api().windows.WINDOW_ID_NONE;
}

async function tabTitle(tabId: number): Promise<string | null> {
  try {
    return (await api().tabs.get(tabId)).title ?? null;
  } catch {
    return null;
  }
}

/* ── The drawer ───────────────────────────────────────────────────────────── */

function row(label: string, onOpen?: () => void): HTMLElement {
  const div = document.createElement("div");
  div.className = "row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row__label";
  button.textContent = label;
  button.title = label;
  if (onOpen) button.addEventListener("click", onOpen);
  else button.disabled = true;
  div.append(button);
  return div;
}

function withAction(
  container: HTMLElement,
  label: string,
  onClick: () => void,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row-button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  container.append(button);
  return container;
}

function emptyNote(host: HTMLElement, text: string): void {
  const p = document.createElement("p");
  p.className = "drawer__empty";
  p.textContent = text;
  host.append(p);
}

async function refreshDrawer(): Promise<void> {
  if (sessionList) {
    sessionList.textContent = "";
    const sessions = await listSessions();
    if (sessions.length === 0) emptyNote(sessionList, "Nothing yet.");
    for (const meta of sessions) {
      const item = row(meta.title, () => {
        void openSession(meta.id);
      });
      if (meta.id === sessionId) item.classList.add("row--current");
      sessionList.append(
        withAction(item, "Delete", () => {
          void deleteSession(meta.id).then(async () => {
            if (meta.id === sessionId) startNewChat();
            await refreshDrawer();
          });
        }),
      );
    }
  }

  if (siteList) {
    siteList.textContent = "";
    // Reconcile before listing. The user can revoke host access from
    // chrome://extensions and Chrome does not tell us, so without this they see
    // a site they believe is approved and we already know is not.
    const known = (await listGrants()).map((g) => g.origin);
    await pruneRevokedGrants(known);
    const grants = await listGrants();
    if (grants.length === 0) {
      emptyNote(
        siteList,
        "None yet. Atlarix asks the first time it needs one.",
      );
    }
    for (const grant of grants) {
      siteList.append(
        withAction(row(grant.origin), "Remove", () => {
          // Removes Chrome's permission AND our record, in that order — a
          // record without the permission is a grant that silently does not
          // work.
          void revokeHostAccess(grant.origin).then(refreshDrawer);
        }),
      );
    }
  }

  if (memoryList) {
    memoryList.textContent = "";
    const memories = await listMemories();
    if (memories.length === 0) {
      emptyNote(memoryList, "Nothing yet. Ask Atlarix to remember something.");
    }
    for (const memory of memories) {
      memoryList.append(
        withAction(row(memory.text), "Forget", () => {
          void forget(memory.id).then(refreshDrawer);
        }),
      );
    }
  }
}

async function openSession(id: string): Promise<void> {
  sessionId = id;
  messages = await loadSession(id);
  renderConversation(messages);
  showDrawer(false);
  await refreshDrawer();
}

function startNewChat(): void {
  sessionId = newSessionId();
  messages = [];
  renderConversation(messages);
  setStatus("");
  showDrawer(false);
}

function showDrawer(open: boolean): void {
  if (drawer) drawer.hidden = !open;
  if (chat) chat.hidden = open;
  drawerButton?.setAttribute("aria-expanded", String(open));
  if (open) void refreshDrawer();
}

/* ── Models ───────────────────────────────────────────────────────────────── */

/**
 * Fill the picker from the PROXY's answer, never from `core-models.json`.
 *
 * That file is the source the proxy is configured from, but it is served from a
 * CDN and it is not the same question: what matters is which models this caller
 * may use right now.
 *
 * THE OPTION VALUE IS THE WIRE ID — see `model-choice.ts`, which holds the
 * reason and the test. A stored choice is offered immediately so a returning
 * user can send before the list arrives; a first-time user waits, because there
 * is no id to guess and guessing one would turn an unreachable proxy into a
 * confusing `model_not_permitted`.
 */
async function loadModels(): Promise<void> {
  if (!modelSelect) return;
  const stored = await readStoredModel();

  const fill = (
    options: { value: string; label: string }[],
    chosen: string | null,
  ) => {
    modelSelect.textContent = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      modelSelect.append(node);
    }
    if (chosen) modelSelect.value = chosen;
    modelSelect.disabled = options.length <= 1;
    if (sendButton) sendButton.disabled = !chosen;
  };

  fill(
    stored
      ? [{ value: stored, label: shortModelName(stored) }]
      : [{ value: "", label: "Loading models…" }],
    stored,
  );

  try {
    const options = optionsFor(await listModels());
    const chosen = chooseModel(options, stored);
    if (chosen) fill(options, chosen);
    else if (!stored) fill([{ value: "", label: "No models available" }], null);
  } catch (err) {
    // AN EXPIRED SESSION IS NOT AN OUTAGE, and collapsing the two is how this
    // panel told a signed-out user to check their connection. `CoreError`
    // already separates them — the only thing that was missing was looking.
    if (
      err instanceof CoreError &&
      (err.status === 401 || err.code === "not_signed_in")
    ) {
      fill([{ value: "", label: "Sign in to choose a model" }], null);
      void handleAuthLoss("Your session expired. Sign in again.");
      return;
    }
    // A stored choice still works against a proxy that is merely slow, and will
    // produce a real error on send. A first-time user is told here rather than
    // discovering it after typing a question.
    if (!stored) {
      fill([{ value: "", label: "Atlarix Core is unreachable" }], null);
      setStatus(
        "Could not reach Atlarix Core. Check your connection and reopen this panel.",
      );
    }
  }
}

async function readStoredModel(): Promise<string | null> {
  try {
    const bag =
      await api().storage.local.get<Record<string, unknown>>(MODEL_KEY);
    const value = bag?.[MODEL_KEY];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

/**
 * Report a browser that cannot deliver the full tool contract.
 *
 * Degrading LOUDLY is the rule this package is built on: a missing capability
 * must say so, never be worked around with a synthetic substitute that looks
 * like it worked.
 *
 * LOUD IS ONLY A VIRTUE WHEN IT IS TRUE. The first version of this said "This
 * browser is missing: trustedInput, tabGroups, offscreenDocument" on a healthy
 * Chrome, because those namespaces do not exist until the manifest asks for the
 * permission. `missingCapabilities` now excludes anything merely un-requested,
 * so silence here means there is nothing wrong.
 */
function reportCapabilities(): void {
  const missing = missingCapabilities(detectCapabilities());
  if (missing.length > 0) {
    setStatus(`This browser cannot support: ${missing.join(", ")}.`);
  }
}

/**
 * Show whichever half matches the account state — after establishing it.
 *
 * "SIGNED IN" MEANS A USABLE TOKEN, NOT A STORED RECORD, and that distinction is
 * the whole of a bug this panel shipped with. `getSession()` returns whatever is
 * in `storage.local`, including a session whose access token expired hours ago
 * and whose refresh token has since been spent. The panel read that as signed
 * in, hid the provider buttons, and rendered a chat — while every Core call came
 * back 401. The user was left looking at an interface with no way in and no way
 * out, and the only message on screen blamed the network.
 *
 * `getAccessToken()` is the honest question: it refreshes if it can, and CLEARS
 * the session if the refresh is refused. Asking it here means the panel's idea of
 * the account and Core's idea of the account are established by the same call, at
 * the one moment the user is looking.
 */
async function render(): Promise<void> {
  const { signedIn: isIn, session } = await accountState();

  if (signedOut) signedOut.hidden = isIn;
  if (chat) chat.hidden = !isIn || Boolean(drawer && !drawer.hidden);
  if (newChatButton) newChatButton.hidden = !isIn;
  if (drawerButton) drawerButton.hidden = !isIn;
  if (drawer && !isIn) drawer.hidden = true;

  for (const button of providerButtons) button.disabled = isIn;

  if (isIn && session) {
    const who = session.user?.email ?? session.user?.id ?? "Signed in";
    if (accountEmail) accountEmail.textContent = who;
    if (accountChip) {
      // The account is stated in the HEADER, not only inside a drawer behind an
      // unlabelled icon. "How do I sign out" was a real question asked of this
      // panel, and the answer being two discoveries deep was the reason.
      accountChip.textContent = who;
      accountChip.title = `${who} — account, history and settings`;
      accountChip.hidden = false;
    }
    // Reopening the panel lands you back in the conversation you were having,
    // which is what a docked panel implies. A blank chat every time makes the
    // history list the only way back to work that was one click away.
    const [recent] = await listSessions();
    if (recent) {
      sessionId = recent.id;
      messages = await loadSession(recent.id);
    }
    renderConversation(messages);
    await loadModels();
  } else {
    if (accountChip) accountChip.hidden = true;
    reportCapabilities();
  }
}

/**
 * Core says this session is not usable. Return the panel to signed-out.
 *
 * Reached when a token that was fine at panel open is refused mid-session —
 * revoked elsewhere, or the refresh token spent by another context. Leaving the
 * chat on screen would put the user back in the state this whole change exists
 * to remove: an interface with no way in and no way out.
 */
async function handleAuthLoss(message: string): Promise<void> {
  await signOut();
  sessionId = newSessionId();
  messages = [];
  showDrawer(false);
  await render();
  setStatus(message);
}

/* ── Wiring ───────────────────────────────────────────────────────────────── */

for (const button of providerButtons) {
  button.addEventListener("click", () => {
    const provider = button.dataset.provider as OAuthProvider | undefined;
    if (!provider) return;

    // Disable every provider for the round trip. A second click would start a
    // SECOND OAuth flow with its own verifier, and whichever finished last
    // would win — so the user could end up signed in as a different account
    // than the window they were looking at.
    for (const b of providerButtons) b.disabled = true;
    setStatus("Opening sign-in…");

    void signIn(provider)
      .then(async (result) => {
        // `render` owns the status line, so anything worth saying about the
        // attempt has to be said AFTER it — otherwise the message is written
        // and then immediately cleared, which looks like nothing happened.
        await render();
        if (result.kind === "cancelled") setStatus("Sign-in cancelled.");
        else if (result.kind === "error") setStatus(result.message);
        else setStatus("");
      })
      .catch((err: unknown) => {
        // `signIn` throws only for a pinned-id mismatch, which is a build or
        // config fault rather than a user one — and the message says which end
        // to fix.
        setStatus(err instanceof Error ? err.message : String(err));
        for (const b of providerButtons) b.disabled = false;
      });
  });
}

/**
 * Closing the agent's tab group means STOP.
 *
 * It is the most discoverable stop an extension has — the tabs are right there,
 * grouped and labelled, and the close button is the browser's own. A gesture
 * that looks like a stop and merely tidies our bookkeeping is worse than no
 * gesture at all, because the user believes they have stopped it.
 *
 * Registered once at load. `onGroupClosed` reports which WINDOW went away, so a
 * group closed in another window does not cancel a turn the user can see.
 */
onGroupClosed((windowId) => {
  void currentWindowId().then((mine) => {
    if (windowId !== mine || !running) return;
    running.abort();
    setStatus("Stopped — you closed Atlarix's tab group.");
  });
});

sendButton?.addEventListener("click", () => void send());

stopButton?.addEventListener("click", () => {
  running?.abort();
  setStatus("Stopping…");
});

input?.addEventListener("keydown", (event) => {
  // Enter sends, Shift+Enter breaks the line — the convention every chat
  // surface uses, including the desktop app's composer.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});

input?.addEventListener("input", () => {
  if (!input) return;
  // Grow with the text, up to the CSS max-height. Reset first: without it the
  // box can only ever get taller, because scrollHeight includes the height it
  // already has.
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

newChatButton?.addEventListener("click", startNewChat);

drawerButton?.addEventListener("click", () => {
  showDrawer(Boolean(drawer?.hidden));
});

accountChip?.addEventListener("click", () => {
  showDrawer(Boolean(drawer?.hidden));
});

modelSelect?.addEventListener("change", () => {
  void api().storage.local.set({ [MODEL_KEY]: modelSelect.value });
});

/**
 * Erase everything, behind a second click.
 *
 * NOT a `confirm()` dialog. A modal dialog in an extension page blocks the
 * whole document, and this panel may have a turn running in it — but the real
 * reason is narrower: `window.confirm` is one of the things a side panel is
 * awkward about, and an inline "Are you sure?" on the button itself is clearer
 * than a box that appears somewhere else on the screen.
 *
 * It deliberately does NOT sign the user out. Erasing what is stored here and
 * ending a session are different intentions, and bundling them means anyone who
 * wants one has to accept the other.
 */
let eraseArmed = false;
eraseButton?.addEventListener("click", () => {
  if (!eraseArmed) {
    eraseArmed = true;
    eraseButton.dataset.confirming = "true";
    eraseButton.textContent = "Erase everything — click again";
    // Disarm on the way out, so a button left armed in a closed drawer does not
    // become a one-click erase the next time it is opened.
    window.setTimeout(disarmErase, 6000);
    return;
  }
  disarmErase();
  eraseButton.disabled = true;
  void (async () => {
    // Chrome's own permissions go with the record. `revokeAll` alone would
    // leave the browser still granting host access for sites the user believes
    // they have just erased.
    for (const grant of await listGrants())
      await revokeHostAccess(grant.origin);
    await revokeAll();
    await deleteAllSessions();
    await forgetAll();
    startNewChat();
    showDrawer(true);
    setStatus("Erased.");
  })()
    .catch((err: unknown) => setStatus(String(err)))
    .finally(() => {
      if (eraseButton) eraseButton.disabled = false;
    });
});

function disarmErase(): void {
  if (!eraseButton) return;
  eraseArmed = false;
  delete eraseButton.dataset.confirming;
  eraseButton.textContent = "Erase everything";
}

signOutButton?.addEventListener("click", () => {
  setStatus("Signing out…");
  void signOut()
    .then(() => {
      // The conversation belongs to the account that had it. Leaving it on
      // screen after a sign-out shows the next person to open this panel what
      // the last one was doing.
      sessionId = newSessionId();
      messages = [];
      showDrawer(false);
      return render();
    })
    .then(() => setStatus(""))
    .catch((err: unknown) => setStatus(String(err)));
});

void render();
