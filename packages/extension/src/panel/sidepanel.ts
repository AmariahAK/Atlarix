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
import { profileOf } from "../auth/profile";
import type { OAuthProvider } from "../auth/gotrue";
import {
  canActOn,
  pruneRevokedGrants,
  requestHostAccess,
  revokeHostAccess,
} from "../permissions/host-access";
import { syncSiteGrants } from "../permissions/grants-sync";
import { buildQuestionCard } from "./question-card";
import { mountAtlarixMark } from "./atlarix-mark";
import { listGrants, revokeAll } from "../permissions/site-grants";
import { activeTab } from "../page/inject";
import { detachAll } from "../page/trusted-input";
import { onGroupClosed, setGroupTitle } from "../tabs/group";
import {
  CoreError,
  listModels,
  userText,
  type ContentPart,
  type CoreMessage,
  type CoreModel,
  type ToolCall,
} from "../core/client";
import { runTurn } from "../agent/loop";
import { clearDrivenTabs, type Approval } from "../tools/dispatch";
import { buildSystemPrompt } from "../agent/prompt";
import { buildNotesSection } from "../memory/index-render";
import { migrateLegacyFacts } from "../memory/migrate";
import { syncNotes } from "../memory/sync";
import { listAccountSkills, skillIndexLines } from "../tools/skills";
import { listConnectorNames } from "../tools/connector-names";
import { deleteAllNotes, listNotes } from "../memory/notes";
import {
  deleteAllSessions,
  deleteSession,
  listSessions,
  loadSession,
  newSessionId,
  rewindToUserMessage,
  saveSession,
} from "../sessions/store";
import { generateTitle } from "../sessions/title";
import {
  appendArchive,
  deleteArchive,
  deleteArchives,
} from "../sessions/archive";
import { deleteRemoteConversation, pushConversation } from "../sessions/sync";
import { renderMarkdown } from "./markdown";
import { mayRotate, nextTip } from "./composer-tips";
import { questionsFromArgs, type AskUserQuestion } from "../tools/ask-user";
import { chooseModel, optionsFor, shortModelName } from "./model-choice";
import { summariseSteps, type Step } from "./steps";
import {
  buildUserContent,
  describeAttachment,
  gateAttachments,
  readAttachment,
  type Attachment,
} from "./attachments";
import { TOOL_SCHEMAS } from "../tools/schemas";
import {
  estimateTokens,
  measureContext,
  usableContextBudget,
  usedTokensFor,
  type UsageAnchor,
} from "../context/budget";
import {
  loadCalibration,
  observe,
  ratioFor,
  saveCalibration,
  type Calibration,
} from "../context/calibration";
import {
  compactConversation,
  isCompactionMarker,
  markerBody,
  markerGeneration,
} from "../context/compact";
import { summariserFor } from "../context/summarise";
import { contextBarView } from "./context-bar";

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
const attachButton = el<HTMLButtonElement>("attach");
const attachInput = el<HTMLInputElement>("attach-input");
const attachmentList = el<HTMLElement>("attachments");
const composer = document.querySelector<HTMLElement>(".composer");
const contextBar = el<HTMLElement>("context-bar");
const contextBarFill = el<HTMLElement>("context-bar-fill");
const contextBarLabel = el<HTMLElement>("context-bar-label");
const newChatButton = el<HTMLButtonElement>("new-chat");
const drawerButton = el<HTMLButtonElement>("toggle-drawer");
const accountEmail = el<HTMLElement>("account-email");
const signOutButton = el<HTMLButtonElement>("sign-out");
const accountChip = el<HTMLButtonElement>("account-chip");
const eraseButton = el<HTMLButtonElement>("erase-all");
const sessionList = el<HTMLElement>("session-list");
const status = el<HTMLElement>("status");
const markCanvas = el<HTMLCanvasElement>("panel-mark");
/** Null only if the canvas is missing, which `wiring.test.ts` would catch. */
const mark = markCanvas ? mountAtlarixMark(markCanvas) : null;
const providerButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-provider]"),
);

let sessionId = newSessionId();
/**
 * The open conversation's name, so `recall` can address a hit as a place rather
 * than a uuid. Refreshed whenever the drawer is, and when the generator names it.
 */
let currentTitle = "";
/**
 * The label the panel showed for each tool call.
 *
 * The ONLY thing about a tool call that syncs — "Reading example.com", never
 * what the page said. Kept here because the label is decided when the result is
 * rendered and needed later, when the conversation is pushed.
 */
const toolLabels = new Map<string, string>();
let messages: CoreMessage[] = [];

/* ── Attachments ──────────────────────────────────────────────────────────── */

/** Staged for the next message. Cleared once it is sent. */
let staged: Attachment[] = [];

/**
 * Read a File in the browser's own way.
 *
 * `FileReader` rather than `file.text()` for the data-URL case because there is
 * no promise-based equivalent, and `file.text()` for the text case because
 * `FileReader` would decode bytes we would then have to re-encode.
 */
const fileReaders = {
  text: (f: File) => f.text(),
  dataUrl: (f: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error(`Could not read ${f.name}`));
      reader.readAsDataURL(f);
    }),
};

function renderAttachments(): void {
  if (!attachmentList) return;
  attachmentList.textContent = "";
  attachmentList.hidden = staged.length === 0;
  staged.forEach((attachment, index) => {
    const chip = document.createElement("span");
    chip.className = "attachment";

    const name = document.createElement("span");
    name.className = "attachment__name";
    name.textContent = describeAttachment(attachment);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment__remove";
    remove.textContent = "×";
    remove.title = `Remove ${attachment.name}`;
    remove.setAttribute("aria-label", `Remove ${attachment.name}`);
    remove.addEventListener("click", () => {
      staged = staged.filter((_, i) => i !== index);
      renderAttachments();
    });

    chip.append(name, remove);
    attachmentList.append(chip);
  });
}

/**
 * Stage files the user picked, pasted or dropped.
 *
 * Refusals are reported as they happen rather than at send time. A file that
 * cannot be read should say so while the user is still looking at the act of
 * attaching it, not a paragraph later when they press Send.
 */
async function stageFiles(files: FileList | File[]): Promise<void> {
  const refusals: string[] = [];
  for (const file of Array.from(files)) {
    try {
      const { attachment, refusal } = await readAttachment(file, fileReaders);
      if (attachment) staged.push(attachment);
      if (refusal) refusals.push(refusal);
    } catch (err) {
      refusals.push(
        `${file.name} could not be read — ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }
  renderAttachments();
  if (refusals.length > 0) setStatus(refusals.join(" "));
}
let running: AbortController | null = null;

/* ── Context measurement ──────────────────────────────────────────────────── */

/**
 * The lineup as the proxy last described it, kept so the bar can look up the
 * window of whichever model is selected.
 *
 * The window is NOT a constant here and must not become one. It comes from
 * `/v1/models`, which reads it from the same models.dev catalog the proxy bills
 * from — so when the Core lineup moves, the bar moves with it. A hardcoded
 * 128,000 would be wrong for three of the four tiers the day it was written.
 */
let lineup: CoreModel[] = [];

/**
 * Tokens the model sees on every round that are not in the transcript: the
 * system prompt and the tool schemas.
 *
 * MEASURED, NOT GUESSED, and it is not a rounding error — roughly 2,500 tokens
 * of fixed overhead per round. Leaving it out of the bar would show a
 * conversation as emptier than it is, and the error is largest exactly when the
 * transcript is short and the user is least likely to suspect it.
 *
 * The tool half never changes within a build. The prompt half does — it carries
 * the active tab and the user's notes index — so it is re-measured from the real
 * prompt at the start of every turn, and seeded here with the context-free
 * version so the first render is close rather than zero.
 */
const TOOL_SCHEMA_TOKENS = estimateTokens(JSON.stringify(TOOL_SCHEMAS));
let systemPromptTokens = estimateTokens(
  buildSystemPrompt({ notes: null, activeTab: null }),
);

/** True only while the compactor is actually running, so the bar can pulse. */
let compacting = false;

/**
 * The last EXACT measurement of this conversation, from the provider itself.
 *
 * Everything this extension can compute for itself is an estimate; this is not.
 * After a round the provider has said precisely what the request cost, so the
 * measurement becomes "a known number plus the little that has been added
 * since" — and the error resets to zero every turn rather than compounding
 * across a long conversation.
 *
 * Cleared whenever the transcript stops being the one it measured: a new chat,
 * a different conversation, a rewind, or a compaction.
 */
let usageAnchor: UsageAnchor | null = null;

/** Learned characters-per-token, by model. See `context/calibration.ts`. */
let calibration: Calibration = { ratios: {} };

/** The ratio to estimate with right now. */
function charsPerToken(): number {
  return ratioFor(calibration, modelSelect?.value ?? "");
}

/**
 * Redraw the bar from the current transcript and the selected model.
 *
 * Cheap enough to call on every change: it is arithmetic over strings already in
 * memory, with no storage read and no network.
 */
function refreshContextBar(): void {
  if (!contextBar || !contextBarFill || !contextBarLabel) return;

  const selected = lineup.find((m) => m.id === modelSelect?.value);
  const status =
    selected?.contextWindow != null
      ? measureContext({
          messages,
          overheadTokens: systemPromptTokens + TOOL_SCHEMA_TOKENS,
          charsPerToken: charsPerToken(),
          anchor: usageAnchor,
          contextWindow: selected.contextWindow,
          // A tier with no output row in the catalog gets no reply reserve,
          // which makes `usable` the whole window — optimistic, and the wrong
          // way to be wrong. 32,000 is a reasoning model's output floor and the
          // same number the desktop's `getMaxTokensWithFloor` settles on.
          maxOutputTokens: selected.maxOutputTokens ?? 32_000,
        })
      : null;

  const view = contextBarView(status, {
    compacting,
    hasMessages: messages.length > 0,
  });

  contextBar.hidden = view.hidden;
  if (view.hidden) return;
  contextBar.dataset.health = view.health;
  contextBar.dataset.busy = String(view.busy);
  contextBarFill.style.width = `${Math.round(view.fill * 100)}%`;
  contextBarLabel.textContent = view.label;
}

/**
 * Shrink the conversation, if it needs it, before the turn goes out.
 *
 * RETURNS WHAT TO SEND AND WHAT TO KEEP, and they are the same thing — which is
 * the change from `pruneForModel`. That pruned on the way OUT only: what was
 * stored stayed whole, so every round re-sent a transcript that had grown past
 * the window and re-paid to have it clipped again. A durable summary is written
 * back into the conversation, so the next round starts from the smaller one.
 *
 * The user's messages are never touched. They are the only part of a
 * conversation that cannot be regenerated; a page can always be read again.
 */
async function compactIfNeeded(
  model: string,
  systemTokens: number,
  signal: AbortSignal,
): Promise<void> {
  const selected = lineup.find((m) => m.id === model);
  const usable = usableContextBudget({
    contextWindow: selected?.contextWindow ?? 0,
    maxOutputTokens: selected?.maxOutputTokens ?? 32_000,
  });
  // An unknown window is not a small one. Compacting against a guess would
  // summarise conversations that had plenty of room.
  if (usable <= 0) return;

  const overheadTokens = systemTokens + TOOL_SCHEMA_TOKENS;
  const { usedTokens } = usedTokensFor({
    messages,
    overheadTokens,
    charsPerToken: charsPerToken(),
    anchor: usageAnchor,
  });
  if (usedTokens <= usable) return;

  compacting = true;
  refreshContextBar();
  try {
    const result = await compactConversation({
      messages,
      overheadTokens,
      usable,
      charsPerToken: charsPerToken(),
      summarise: summariserFor(model),
      signal,
    });
    if (!result.changed) return;
    messages = result.messages;
    // The anchor measured a transcript that no longer exists. Keeping it would
    // report the pre-compaction size of a conversation that just got smaller —
    // the bar would stay full and the compactor would run again immediately.
    usageAnchor = null;
    // Re-rendered because a marker replaced real turns on screen, and the
    // transcript must show what the model can actually see. A conversation that
    // still displays six page reads the model no longer has is a conversation
    // whose next answer looks like amnesia.
    renderConversation(messages);
    await persist();
    setStatus(
      result.summarised
        ? "Summarised the earlier part of this conversation to make room."
        : `Freed room in this conversation — ${result.steps.join(", ")}.`,
    );
  } finally {
    compacting = false;
    refreshContextBar();
  }
}

function setStatus(message: string): void {
  if (status) status.textContent = message;
}

/* ── The transcript ───────────────────────────────────────────────────────── */

/**
 * Whether to keep following the stream.
 *
 * A LATCH SET BY THE USER'S OWN SCROLLING, not a measurement taken at append
 * time. Measuring per append was the bug: a streamed answer re-renders its
 * whole bubble on every delta, each re-render changes `scrollHeight` between
 * the measurement and the write, and the result was a transcript that dragged
 * itself back down while the user was trying to read something above it.
 * Reported as "I cannot scroll up and down".
 *
 * Latching also makes the intent durable — scroll up once and you stay there
 * until you deliberately return to the bottom, which is what every chat surface
 * does and what people expect without being told.
 */
let following = true;

/** Within a line or two of the end. */
function atBottom(): boolean {
  if (!transcript) return true;
  return (
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <
    40
  );
}

transcript?.addEventListener(
  "scroll",
  () => {
    following = atBottom();
  },
  { passive: true },
);

/** Ride the bottom, but only while the user is actually there. */
function stickToBottom(): void {
  if (following && transcript) transcript.scrollTop = transcript.scrollHeight;
}

function append(node: HTMLElement): HTMLElement {
  transcript?.append(node);
  stickToBottom();
  return node;
}

/**
 * Something the user said, with a way to say it differently.
 *
 * EDIT REWINDS, it does not patch. The conversation after this message is
 * discarded and the turn re-runs — because everything after it was a RESPONSE
 * to the old wording, and keeping it would leave the model reading an exchange
 * that never happened. That is also why the button says what it will do.
 *
 * Disabled while a turn is running: rewinding under a live loop would have two
 * turns writing to the same transcript.
 */
function userBubble(
  content: string | ContentPart[],
  index: number,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--user";

  const body = document.createElement("div");
  body.className = "msg__text";
  body.textContent = userText(content);

  // AN ATTACHED IMAGE IS SHOWN BACK. Rendering it as "[attached image]" makes a
  // user scrolling their own history unable to tell which screenshot they sent,
  // and the bytes are already in the transcript — there is nothing to fetch.
  if (typeof content !== "string") {
    for (const part of content) {
      if (part.type !== "image_url") continue;
      const img = document.createElement("img");
      img.className = "bubble__image";
      img.src = part.image_url.url;
      img.alt = "Attached image";
      body.append(img);
    }
  }

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "msg__edit";
  edit.textContent = "Edit";
  edit.title = "Edit this message and ask again from here";
  edit.addEventListener("click", () => {
    if (running) return;
    // The TEXT goes back in the composer; the attachments do not. Their bytes
    // are in the transcript and could be restored, but silently re-attaching a
    // file someone is about to rewrite the question about is the kind of help
    // that gets sent by accident. They re-attach if they still mean to.
    beginEdit(index, userText(content));
  });

  wrap.append(body, edit);
  return wrap;
}

/**
 * Put a past message back in the composer and forget everything after it.
 *
 * The rewind happens on SEND, not here — so changing your mind about editing
 * costs nothing, and the transcript you are reading stays whole until you
 * actually commit to replacing it.
 */
let editingFrom: number | null = null;

function beginEdit(index: number, text: string): void {
  if (!input) return;
  editingFrom = index;
  input.value = text;
  input.focus();
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  // Say what Send will do now, because it is no longer "add to this
  // conversation" — it is "replace the rest of it".
  if (sendButton) sendButton.textContent = "Resend";
  setStatus("Editing — sending replaces everything after this message.");
  document
    .querySelectorAll(".msg--user")
    .forEach((el, i) => el.classList.toggle("msg--editing", i === index));
}

function cancelEdit(): void {
  editingFrom = null;
  if (sendButton) sendButton.textContent = "Send";
  document
    .querySelectorAll(".msg--editing")
    .forEach((el) => el.classList.remove("msg--editing"));
}

/* ── The activity card ────────────────────────────────────────────────────── */

/**
 * One collapsed card holding everything the agent did, with the per-step cards
 * still inside it.
 *
 * WHY. A turn that read two pages and filled six fields produced fourteen
 * stacked cards, and the ANSWER — the thing the person asked for — was pushed
 * off the bottom of a 320px panel. Nothing is removed: open this and every step
 * is there, each still expandable to its full output.
 *
 * The steps live in a plain `div` rather than nested `details`, because a
 * `details` inside a closed `details` cannot be opened, and the whole point is
 * that a developer can still get at any single step.
 */
interface StepsCard {
  root: HTMLDetailsElement;
  body: HTMLElement;
  line: HTMLElement;
  steps: Step[];
}

function stepsCard(): StepsCard {
  const root = document.createElement("details");
  root.className = "steps";
  // OPEN WHILE IT RUNS, collapsed once it is done. Thinking is the only thing on
  // screen for the first ten seconds of a turn on a reasoning tier, so a card
  // that starts closed is a panel that looks frozen — which is exactly the bug
  // the thinking block was added to fix, reintroduced one level up.
  root.open = true;

  const summary = document.createElement("summary");
  summary.className = "steps__summary";
  const dot = document.createElement("span");
  dot.className = "tool__dot";
  const line = document.createElement("span");
  line.className = "steps__line";
  line.textContent = "Working…";
  summary.append(dot, line);

  const body = document.createElement("div");
  body.className = "steps__body";

  root.append(summary, body);
  return { root, body, line, steps: [] };
}

/** Add a step's card, and re-describe the whole run. */
function addStep(
  card: StepsCard,
  step: Step,
  node: HTMLElement,
  running: boolean,
): void {
  card.steps.push(step);
  card.body.append(node);
  card.line.textContent = summariseSteps(card.steps, { running });
}

/** Re-describe without adding, for when a step's label arrives late. */
function settleSteps(card: StepsCard | null): void {
  if (!card) return;
  card.root.classList.add("steps--done");
  // Collapsed now the work is history and the answer is what the person came
  // for. They can open it again; it just stops taking the screen.
  card.root.open = false;
  card.line.textContent = summariseSteps(card.steps);
}

function assistantBubble(text = ""): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg msg--assistant";
  if (text) renderMarkdown(div, text);
  return div;
}

/**
 * The model's thinking, collapsed.
 *
 * IT IS THE ONLY THING ON SCREEN FOR THE FIRST TEN SECONDS of a turn on a
 * reasoning tier, so leaving it out is what made the panel look frozen. Open by
 * default WHILE it streams — that is the point, there is nothing else to watch —
 * and collapsed the moment the answer starts, because by then it is history and
 * the answer is what the person came for.
 */
function thinkingBlock(): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "tool thinking";
  details.open = true;
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "tool__dot";
  summary.append(dot, document.createTextNode("Thinking…"));
  const body = document.createElement("pre");
  body.className = "tool__body";
  details.append(summary, body);
  return details;
}

function settleThinking(details: HTMLDetailsElement | null): void {
  if (!details) return;
  details.open = false;
  details.classList.remove("thinking--live");
  const summary = details.querySelector("summary");
  if (summary) {
    summary.textContent = "";
    const dot = document.createElement("span");
    dot.className = "tool__dot";
    summary.append(dot, document.createTextNode("Thought for a moment"));
  }
}

/**
 * "Working…", shown from the instant Send is pressed.
 *
 * THE FIRST TOKEN CAN BE TEN SECONDS AWAY on a reasoning model, and until it
 * arrives there is nothing to render — which read as a dead panel with a Stop
 * button. This is replaced by whatever comes first: thinking, text, or a tool.
 */
function workingRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "tool tool--running working";
  const summary = document.createElement("div");
  summary.className = "working__line";
  const dot = document.createElement("span");
  dot.className = "tool__dot";
  summary.append(dot, document.createTextNode("Working…"));
  row.append(summary);
  return row;
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

function fillChip(
  details: HTMLDetailsElement,
  result: string,
  label?: string,
): void {
  details.classList.remove("tool--running");
  // Re-label from the RESULT when there is one. The call could only say
  // "Reading tab 554527245"; the result knows it was the Tardigrade article.
  const summary = label ? details.querySelector("summary") : null;
  if (summary) {
    summary.textContent = "";
    const dot = document.createElement("span");
    dot.className = "tool__dot";
    summary.append(dot, document.createTextNode(label as string));
  }
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
    case "click":
      return `Clicking ${String(args.ref ?? args.selector ?? "an element")}`;
    case "fill":
      // The REF, never the value. This line is rendered and may be read over a
      // shoulder; the value is sometimes a password.
      return `Filling ${String(args.ref ?? args.selector ?? "a field")}`;
    case "press_key":
      return `Pressing ${String(args.key ?? "")}`;
    case "hover":
      return `Hovering ${String(args.ref ?? args.selector ?? "an element")}`;
    case "scroll":
      return `Scrolling ${String(args.direction ?? "")}`;
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
 * The approval card, and the promise the loop is waiting on.
 *
 * TWO KINDS THROUGH ONE CARD. A host grant and a dangerous action are different
 * problems with the same answer: only the user can say yes.
 *
 * For a host grant, `requestHostAccess` is called from INSIDE the click handler,
 * synchronously, because that is what makes it a user gesture —
 * `permissions.request()` has no other way to succeed, and it resolves FALSE on
 * a decline rather than rejecting, which is why `host-access.ts` orders the
 * record after the answer.
 *
 * For an action, there is no platform call at all: the yes IS the answer. The
 * card still refuses to show the value being typed — `always-ask.ts` builds its
 * reason without it deliberately, because this string is rendered and may be
 * logged on the path where that value is a password.
 */
/**
 * The card `ask_user` renders — built in `question-card.ts`, wired here.
 *
 * The composer is this module's, so the fill callback is passed in rather than
 * reached for: that is what lets the card's ordering, numbering and skip
 * behaviour be tested without mounting the whole panel.
 */
function questionCard(questions: AskUserQuestion[]): HTMLElement {
  return buildQuestionCard(questions, (text) => {
    if (!input) return;
    const current = input.value.trim();
    input.value = current ? `${current}\n\n${text}` : text;
    input.focus();
    // The composer auto-grows on input; a programmatic value set fires no such
    // event, so a long answer would sit in a one-row box.
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function approvalCard(request: Approval): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const card = document.createElement("div");
    card.className = "grant";

    const title = document.createElement("div");
    title.className = "grant__origin";
    title.textContent =
      request.kind === "host"
        ? `Let Atlarix read ${request.origin}?`
        : request.summary;

    const note = document.createElement("p");
    note.className = "grant__note";
    note.textContent =
      request.kind === "host"
        ? "Chrome will ask you to confirm. Atlarix can read this site until you " +
          "remove it, and nothing else."
        : `${request.reason} Allowing a site never covers this — Atlarix asks every time.`;

    const actions = document.createElement("div");
    actions.className = "grant__actions";

    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "button grant__allow";
    allow.textContent = request.kind === "host" ? "Allow" : "Go ahead";

    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "button";
    deny.textContent = request.kind === "host" ? "Not now" : "Stop";

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
      if (request.kind !== "host") {
        settle(true, `Approved: ${request.summary}`);
        return;
      }
      // Inside the gesture. Do NOT await anything before this call.
      void requestHostAccess(request.url).then((outcome) => {
        settle(
          outcome.ok,
          outcome.ok
            ? `Allowed ${request.origin}`
            : outcome.reason === "unsupported-scheme"
              ? `${request.origin} cannot be allowed — Atlarix only reads http(s) pages`
              : `Declined ${request.origin}`,
        );
      });
    });

    deny.addEventListener("click", () => {
      settle(
        false,
        request.kind === "host"
          ? `Declined ${request.origin}`
          : "Stopped — not done",
      );
    });

    actions.append(allow, deny);
    card.append(title, note, actions);
    append(card);
  });
}

/**
 * The line in the transcript where earlier turns became a summary.
 *
 * SHOWN, NOT HIDDEN. The alternative is to leave the earlier bubbles on screen
 * and quietly stop sending them, which makes the next answer look like amnesia —
 * the user can see the exchange they are asking about and the model cannot. A
 * visible seam turns "it forgot" into "it summarised, and here is what it kept".
 *
 * The summary itself is collapsed, because it is written for the model and reads
 * like a form. It is there for the user who wants to check what survived.
 */
function compactionDivider(content: string): HTMLElement {
  const wrap = document.createElement("details");
  wrap.className = "compaction";

  const summary = document.createElement("summary");
  summary.className = "compaction__summary";
  const generation = markerGeneration(content);
  summary.textContent =
    generation > 1
      ? `Earlier turns summarised (${generation} times so far)`
      : "Earlier turns summarised to make room";

  const body = document.createElement("pre");
  body.className = "compaction__body";
  body.textContent = markerBody(content);

  wrap.append(summary, body);
  return wrap;
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

    /*
     * STARTERS, because "what can it do" is not answerable from a blank box.
     * The composer tip rotates through capabilities one at a time and a first
     * run sees exactly one of them. These three are chosen to be the three
     * DIFFERENT things it does — read the page, act on it, reach past it —
     * rather than three phrasings of the first.
     *
     * They fill the composer rather than sending: a starter is a sentence to
     * edit, and one that sent itself would spend a turn on a guess.
     */
    const starters = document.createElement("div");
    starters.className = "empty__starters";
    for (const text of [
      "Summarise this page",
      "Find the pricing on this site",
      "Open the docs for this in a new tab",
    ]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "empty__starter";
      chip.textContent = text;
      chip.addEventListener("click", () => {
        if (!input) return;
        input.value = text;
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      starters.append(chip);
    }
    empty.append(starters);
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

  let userIndex = 0;
  // GROUPED THE SAME WAY A LIVE TURN IS, or reopening a conversation would show
  // it in a different shape from the one the user watched happen — which reads
  // as the transcript having been rewritten.
  let activity: StepsCard | null = null;
  const closeActivity = () => {
    settleSteps(activity);
    activity = null;
  };
  const restoreStep = (step: Step, node: HTMLElement) => {
    // See `stepInto`: the question card is this tool's rendering.
    if (step.kind === "tool" && step.name === "ask_user") return;
    if (!activity) {
      const card = stepsCard();
      // A reopened conversation's work is already finished, so it arrives
      // collapsed rather than expanding every card the user ever ran.
      card.root.open = false;
      transcript.append(card.root);
      activity = card;
    }
    addStep(activity, step, node, false);
  };

  for (const message of history) {
    if (isCompactionMarker(message)) {
      // A MARKER IS NOT A MESSAGE THE USER SENT, however much the transcript
      // says `role: "user"`. Rendered as a user bubble it would appear as
      // something they wrote, carry an Edit button that rewinds to a summary,
      // and — the part that silently breaks — shift every later user message's
      // index by one, so editing the third question would rewind to the second.
      // `userIndex` deliberately does not advance here; `rewindToUserMessage`
      // skips markers for the same reason and must stay in step.
      closeActivity();
      transcript.append(compactionDivider(message.content));
      continue;
    }
    if (message.role === "user") {
      closeActivity();
      transcript.append(userBubble(message.content, userIndex));
      userIndex += 1;
    } else if (message.role === "assistant") {
      // Prose ends a stretch of work; the tool calls on the SAME message open
      // the next one, which is the order they actually happened in.
      if (message.content) {
        closeActivity();
        transcript.append(assistantBubble(message.content));
      }
    } else if (message.role === "tool") {
      const call = callsById.get(message.tool_call_id);
      const resolved = call ?? {
        id: message.tool_call_id,
        type: "function" as const,
        function: { name: "tool", arguments: "{}" },
      };
      const chip = toolChip(resolved);
      fillChip(chip, message.content);
      restoreStep({ kind: "tool", name: resolved.function.name }, chip);
      // THE QUESTION IS RE-DERIVED, NOT STORED. `saveSession` already persists
      // the assistant message's `tool_calls`, so the arguments are here — which
      // is what lets a question survive the panel being closed and reopened,
      // the one thing the approval card cannot do.
      if (resolved.function.name === "ask_user") {
        const questions = questionsFromArgs(resolved.function.arguments);
        if (questions.length > 0) {
          closeActivity();
          transcript.append(questionCard(questions));
        }
      }
    }
  }
  // A conversation that ended mid-work leaves a card open.
  closeActivity();
  following = true;
  transcript.scrollTop = transcript.scrollHeight;
  refreshContextBar();
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

function setRunning(isRunning: boolean): void {
  running = isRunning ? running : null;
  // The header mark is the ONLY always-visible indicator that a turn is live:
  // the transcript can be scrolled away from the working card, and the stop
  // button is small. It stops animating the moment the turn ends — see
  // `atlarix-mark.ts` for why a permanently spinning canvas in an all-day side
  // panel is not acceptable.
  mark?.working(isRunning);
  if (sendButton) sendButton.hidden = isRunning;
  if (stopButton) stopButton.hidden = !isRunning;
  if (newChatButton) newChatButton.disabled = isRunning;
  if (input) input.disabled = isRunning;
  if (attachButton) attachButton.disabled = isRunning;
}

async function send(): Promise<void> {
  const text = input?.value.trim() ?? "";
  // An attachment on its own is a real message — "what is in this?" is implied
  // by the act of attaching, and refusing to send it would be pedantry.
  if ((!text && staged.length === 0) || running) return;

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
  // THE REWIND. Everything after the edited message was a response to the old
  // wording; keeping it would leave the model reading an exchange that never
  // happened. Done here rather than when Edit was pressed, so changing your mind
  // about editing costs nothing.
  if (editingFrom !== null) {
    messages = rewindToUserMessage(messages, editingFrom);
    // The anchor counted messages this rewind just removed.
    usageAnchor = null;
    cancelEdit();
    renderConversation(messages);
  }

  if (messages.length === 0) transcript?.replaceChildren();
  // A new message is a request for the newest thing, so follow again.
  following = true;

  const userIndex = messages.filter(
    (m) => m.role === "user" && !isCompactionMarker(m),
  ).length;
  // GATED BEFORE THE ROUND IS SPENT, and the refusal names a tier that works.
  // Core 1 is GLM and is text-only, so an image there has to be turned away —
  // but "Core 3 can read it" is the same sentence with the work done.
  const { accepted, refusals } = gateAttachments(
    staged,
    lineup.find((m) => m.id === model),
    lineup,
  );
  staged = [];
  renderAttachments();

  const userMessage: CoreMessage = {
    role: "user",
    content: buildUserContent(text, accepted),
  };
  messages = [...messages, userMessage];
  append(userBubble(text, userIndex));
  // ARCHIVED AS IT ARRIVES, not at the end of the turn. Compaction rewrites the
  // live transcript in place, so the archive is the only copy of what was
  // actually said — and it has to be written before anything can rewrite it.
  void appendArchive(sessionId, [userMessage]);
  await persist();

  const controller = new AbortController();
  running = controller;
  setRunning(true);
  // The refusals survive here rather than being cleared: they are the answer to
  // "why is my screenshot not in there", and clearing them would leave the
  // question unanswered on the one turn it gets asked.
  setStatus(refusals.join(" "));

  let windowId = api().windows.WINDOW_ID_NONE;
  try {
    // The migration runs before the first read of a turn, is idempotent, and
    // never throws — a corrupt legacy value costs an empty notes section and
    // nothing more.
    await migrateLegacyFacts();
    const [noteMetas, accountSkills, connectorNames, tab, win] = await Promise.all([
      listNotes(),
      // Fetched per turn but cheap and cached by the browser; an empty list on
      // failure simply omits the section, which is the same as having none.
      listAccountSkills(),
      listConnectorNames(),
      activeTab(),
      currentWindowId(),
    ]);
    const notes = buildNotesSection(noteMetas);
    const skills = accountSkills.length
      ? { index: skillIndexLines(accountSkills), count: accountSkills.length }
      : null;
    windowId = win;
    // The group's title is status where the user is already looking. It no-ops
    // until the agent has opened a tab, which is exactly when it starts to
    // matter: a group of tabs that says nothing about why it is there is the
    // thing people close in confusion.
    void setGroupTitle(windowId, "Atlarix · working");
    const system = buildSystemPrompt({
      notes,
      skills,
      connectors: connectorNames,
      activeTab: tab
        ? {
            title: (await tabTitle(tab.id)) ?? "",
            url: tab.url,
            granted: await canActOn(tab.url),
          }
        : null,
    });
    // The real prompt for this turn, notes index and active tab included — so the
    // bar measures what is actually being sent rather than the empty shell.
    systemPromptTokens = estimateTokens(system);

    // Before the turn, not after it: a round that overflows is rejected by the
    // provider, and a rejection costs the same as a successful call.
    await compactIfNeeded(model, systemPromptTokens, controller.signal);

    let bubble: HTMLElement | null = null;
    let streamed = "";
    let thinking: HTMLDetailsElement | null = null;
    let thought = "";
    const chips = new Map<string, HTMLDetailsElement>();

    /**
     * The activity card currently collecting steps.
     *
     * CLOSED WHEN PROSE STARTS, so the transcript reads
     * [activity][answer][activity][answer] rather than interleaving cards with
     * sentences. A model that says "let me check that" mid-turn and then does
     * three more things gets a second card, which is the truthful order — one
     * card per stretch of uninterrupted work.
     */
    // A HOLDER, not a bare `let`, because the only assignment happens inside the
    // event closures below — and TypeScript's control-flow analysis cannot see
    // through that, so a bare `let` narrows to `null` and every use after the
    // turn is a type error about `never`.
    const activity: { card: StepsCard | null } = { card: null };
    const stepInto = (step: Step, node: HTMLElement) => {
      // `ask_user` IS the question card, so it gets no step of its own. It used
      // to produce a one-step "Asked you" card sitting directly above the
      // question it described — the same fact twice, in a 320px panel where
      // every row is a scroll. Nothing is lost: the card exists to summarise
      // work the user cannot otherwise see, and this question is right there.
      if (step.kind === "tool" && step.name === "ask_user") return;
      if (!activity.card) {
        activity.card = stepsCard();
        append(activity.card.root);
      }
      addStep(activity.card, step, node, true);
      stickToBottom();
    };

    // Cleared by the first thing that renders, whatever that is.
    let working: HTMLElement | null = append(workingRow());
    const clearWorking = () => {
      working?.remove();
      working = null;
    };

    const outcome = await runTurn({
      model,
      system,
      // No longer pruned on the way out: `compactIfNeeded` above has already
      // brought the stored conversation itself within the window, so what is
      // sent and what is kept are the same thing. `pruneForModel` remains in
      // `sessions/store.ts` as the disk backstop it always should have been.
      messages,
      tools: { windowId, sessionId, sessionTitle: currentTitle },
      signal: controller.signal,
      events: {
        onReasoning(delta) {
          clearWorking();
          thought += delta;
          if (!thinking) {
            thinking = thinkingBlock();
            stepInto({ kind: "thinking" }, thinking);
          }
          const body = thinking.querySelector("pre");
          if (body) body.textContent = thought;
          stickToBottom();
        },
        onText(delta) {
          clearWorking();
          // The answer has started, so the thinking is history. Collapsing it
          // here rather than at the end of the round is what keeps a long chain
          // of thought from pushing the answer off the bottom of the panel.
          settleThinking(thinking);
          thinking = null;
          thought = "";
          streamed += delta;
          // PROSE ENDS THE RUN. Whatever the model says — a remark on the way
          // or the final answer — belongs in the transcript, not inside a card
          // the user has to open to read it.
          settleSteps(activity.card);
          activity.card = null;
          if (!bubble) bubble = append(assistantBubble());
          renderMarkdown(bubble, streamed);
          stickToBottom();
        },
        onToolCall(call) {
          clearWorking();
          settleThinking(thinking);
          thinking = null;
          thought = "";
          // A new assistant bubble after each tool round, so the transcript
          // reads in the order things happened rather than collecting all the
          // prose at the top.
          bubble = null;
          streamed = "";
          const chip = toolChip(call);
          chips.set(call.id, chip);
          stepInto({ kind: "tool", name: call.function.name }, chip);
        },
        onRound() {
          // Every round after the first waits on the model again, so the
          // indicator has to come back or the panel goes quiet mid-task.
          if (!working) working = append(workingRow());
        },
        onRoundRestart(attempt, reason) {
          // The stream died and cannot be resumed, so everything rendered for
          // this round is void. Leaving it would append the retry's answer to
          // the corpse of the first attempt — the user reads half a sentence
          // twice and concludes the model is broken.
          bubble?.remove();
          bubble = null;
          streamed = "";
          settleThinking(thinking);
          thinking?.remove();
          thinking = null;
          thought = "";
          // The activity card may now be empty; an empty card is a row that says
          // "No steps", which is worse than nothing.
          if (activity.card && activity.card.steps.length === 0) {
            activity.card.root.remove();
            activity.card = null;
          }
          clearWorking();
          working = append(workingRow());
          // SAID OUT LOUD. A silent retry that succeeds hides a flaky
          // connection; one that fails reads as a single unexplained stall.
          setStatus(
            `Connection dropped (${reason}) — retrying, attempt ${attempt + 1}.`,
          );
        },
        onUsage(usage) {
          // The exact size of what was just sent, from the provider's own
          // tokenizer. Both halves of the accuracy story land here.
          usageAnchor = {
            promptTokens: usage.promptTokens,
            messageCount: usage.messageCount,
          };
          const next = observe(
            calibration,
            model,
            usage.charsSent,
            usage.promptTokens,
          );
          if (next !== ratioFor(calibration, model)) {
            void saveCalibration(calibration);
          }
          refreshContextBar();
        },
        onToolResult(call, content, label) {
          const chip = chips.get(call.id);
          if (chip) fillChip(chip, content, label);
          if (label) toolLabels.set(call.id, label);
          // The line is recomputed from the step list, which already holds this
          // tool — this just refreshes the "running" tense now that one finished.
          if (activity.card) {
            activity.card.line.textContent = summariseSteps(
              activity.card.steps,
              { running: true },
            );
          }
        },
        onApproval: approvalCard,
      },
    });

    clearWorking();
    settleThinking(thinking);
    settleSteps(activity.card);
    messages = [...messages, ...outcome.messages];
    void appendArchive(sessionId, outcome.messages);
    await persist();

    setStatus(refusals.join(" "));
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
    } else if (outcome.kind === "asked") {
      // NO STATUS LINE. "Stopped" would be the honest word for the loop and the
      // wrong one for the user: the turn ended because Atlarix asked them
      // something, and the question itself is the status.
      let questions: AskUserQuestion[] = [];
      for (const m of outcome.messages) {
        if (m.role !== "assistant") continue;
        for (const c of m.tool_calls ?? []) {
          if (c.function.name !== "ask_user") continue;
          const parsed = questionsFromArgs(c.function.arguments);
          // The LAST readable ask in the turn wins. The model is told to batch,
          // but if it asked twice the second is the one still outstanding.
          if (parsed.length > 0) questions = parsed;
        }
      }
      if (questions.length > 0) {
        append(questionCard(questions));
        input?.focus();
      }
    }
  } catch (err) {
    append(errorBubble(err instanceof Error ? err.message : String(err)));
  } finally {
    setRunning(false);
    // The USER'S tabs lose the frame now; the agent's own group keeps it for
    // the rest of the conversation, because those tabs remain its workspace and
    // it will very likely touch them again on the next message.
    void clearDrivenTabs("turn");
    // GIVE THE TABS BACK. Chrome shows its debugging banner for exactly as long
    // as a debugger is attached, so staying attached between turns leaves
    // "Atlarix started debugging this browser" on screen for the rest of the
    // day — announcing work that finished minutes ago. The banner's wording is
    // Chromium's and cannot be changed; when it is on screen can be.
    void detachAll();
    void setGroupTitle(windowId, "Atlarix");
    void nameConversation(model);
    void refreshDrawer();
    // BETWEEN turns, which is the only moment a placeholder may change without
    // reading as a glitch. `mayRotate` holds it back if the user has already
    // started typing their next message.
    rotateTip();
    // AFTER the turn, never during one. A pull mid-turn could change a note the
    // model is reading, and the conflict sibling it may create would appear in
    // an index that was already built. Unawaited, like `pushConversation`: an
    // offline laptop must not put an error in front of someone mid-sentence.
    void syncNotesAndReport();
  }
}

/**
 * Reconcile notes with the account, and tell the user if anything collided.
 *
 * THE ONLY PART THAT IS NOT SILENT. Transport failure stays quiet — that is the
 * house rule and it is right, because the local store already works. But a
 * CONFLICT means two people wrote the same note and one copy is now sitting
 * beside the other under a different name; saying nothing would leave a note
 * the user never created and no explanation of where it came from.
 */
async function syncNotesAndReport(): Promise<void> {
  const { conflicts } = await syncNotes();
  if (conflicts.length === 0) return;
  void refreshDrawer();
  setStatus(
    conflicts.length === 1
      ? `"${conflicts[0]}" was also changed elsewhere — both versions are in your notes.`
      : `${conflicts.length} notes were also changed elsewhere — both versions of each are in your notes.`,
  );
}

/**
 * Advance the composer's tip, if now is a moment that may.
 *
 * Called from exactly one place — the end of a turn. A timer was the obvious
 * alternative and is worse: a string that changes while someone is reading it
 * looks broken, and there is no interval short enough to teach anything that is
 * not also long enough to interrupt.
 */
function rotateTip(): void {
  // `input` is nullable for the same reason every element handle here is: the
  // panel document can be torn down mid-turn when the user closes it, and this
  // runs from a `finally`.
  if (!input) return;
  if (!mayRotate({ value: input.value, running: running !== null })) return;
  input.placeholder = nextTip(input.placeholder);
}

/**
 * Give the conversation a real name, once, after the first turn.
 *
 * AFTER, never before: a title is not worth a second of latency in front of the
 * answer. It replaces the derived title — the first user message, truncated —
 * which fills a history list with rows like "hey how are you? could u tell me
 * what url we are on…". Technically the question, useless as a label.
 *
 * Guarded so it runs once per conversation: `saveSession` runs after every round
 * and would otherwise pay for a new title each time.
 */
const named = new Set<string>();
async function nameConversation(model: string): Promise<void> {
  const id = sessionId;
  if (named.has(id)) return;
  const hasReply = messages.some(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content,
  );
  if (!hasReply) return;

  const title = await generateTitle(model, messages);
  // MARKED ONLY ON SUCCESS. Marking before the call meant one failure left a
  // conversation unnamed forever — and when the failure was systematic, as the
  // 32-token cap was, that meant every conversation.
  if (!title) return;
  named.add(id);
  // The user may have moved on while this was in flight. Writing the title onto
  // whatever conversation is open NOW would rename the wrong one.
  if (sessionId !== id) return;
  currentTitle = title;
  await saveSession(id, await loadSession(id), { title });
  await refreshDrawer();
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

async function persist(title?: string): Promise<void> {
  // The bar is redrawn here because `persist` is already the one thing that runs
  // after every round, whatever the round did. Hooking each event separately is
  // how a new tool ends up being the one that does not update it.
  refreshContextBar();
  try {
    const { evicted } = await saveSession(
      sessionId,
      messages,
      title ? { title } : {},
    );
    // `saveSession` drops an evicted conversation's transcript; its archive is a
    // second key under a second name and would otherwise be left behind forever.
    if (evicted.length > 0) {
      void deleteArchives(evicted.map((sn) => sn.id));
    }
    // Cross-device, and deliberately not awaited: a conversation is already
    // saved locally and already on screen, so an offline laptop or an expired
    // token must not put an error in front of someone mid-sentence.
    //
    // RAW TOOL RESULTS DO NOT GO — `syncableRows` sends a tool call's label and
    // nothing more, and the column refuses anything longer. A page read is the
    // contents of whatever the user was looking at.
    void pushConversation({
      id: sessionId,
      title: title?.trim() || currentTitle,
      messages,
      labelFor: (id) => toolLabels.get(id),
    });
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
          // The archive goes with it. An archive whose conversation is gone is
          // invisible, unreachable and still counts against the same quota —
          // and it holds the user's own words, which is the last thing that
          // should outlive a delete they asked for.
          void deleteArchive(meta.id);
          void deleteRemoteConversation(meta.id);
          void deleteSession(meta.id).then(async () => {
            if (meta.id === sessionId) startNewChat();
            await refreshDrawer();
          });
        }),
      );
    }
  }

  // GRANTS: RECONCILE AND SYNC, BUT NO LONGER RENDER. The list moved to the
  // account page; these two calls did not, because neither was ever about
  // rendering.
  //
  //   - `pruneRevokedGrants` keeps our record honest against Chrome, which
  //     drops host access when the user revokes from chrome://extensions and
  //     does not tell us.
  //   - `syncSiteGrants` publishes what survived and APPLIES anything revoked
  //     on the website — `permissions.remove()` first, then the record. A
  //     website cannot reach into Chrome, so this is the only moment a
  //     revocation made there takes effect.
  //
  // Order matters: prune first, so what is published is a list Chrome has
  // already agreed with rather than one we only believe.
  const known = (await listGrants()).map((g) => g.origin);
  await pruneRevokedGrants(known);
  await syncSiteGrants();

}

async function openSession(id: string): Promise<void> {
  void clearDrivenTabs("all");
  cancelEdit();
  sessionId = id;
  toolLabels.clear();
  usageAnchor = null;
  staged = [];
  renderAttachments();
  currentTitle = (await listSessions()).find((sn) => sn.id === id)?.title ?? "";
  messages = await loadSession(id);
  renderConversation(messages);
  showDrawer(false);
  await refreshDrawer();
}

function startNewChat(): void {
  // The tabs may still be open, but they belong to a conversation that is over.
  void clearDrivenTabs("all");
  cancelEdit();
  sessionId = newSessionId();
  currentTitle = "";
  toolLabels.clear();
  usageAnchor = null;
  staged = [];
  renderAttachments();
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

/**
 * The account, as a face rather than a truncated email.
 *
 * A PROVIDER AVATAR IS A REMOTE IMAGE ON SOMEONE ELSE'S CDN. It 404s when the
 * person changes their picture, and some content blockers refuse it outright —
 * so the initials are not a placeholder, they are the other half of the design.
 * Falling back keeps the header's shape instead of leaving a broken-image glyph
 * where a face should be.
 *
 * `referrerpolicy="no-referrer"` matters more here than on a website: without it
 * every panel open tells Google's or GitHub's CDN this extension's id.
 */
function renderAccountChip(profile: {
  avatar: string | null;
  initials: string;
  label: string;
  provider: string;
}): void {
  if (!accountChip) return;
  accountChip.textContent = "";
  accountChip.hidden = false;
  accountChip.title = `${profile.label} — account, history and settings`;
  accountChip.setAttribute(
    "aria-label",
    `${profile.label}. Account, history and settings`,
  );

  const initials = document.createElement("span");
  initials.className = "account-chip__initials";
  initials.textContent = profile.initials;
  accountChip.append(initials);

  if (!profile.avatar) return;

  const img = document.createElement("img");
  img.className = "account-chip__avatar";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  // Swap only once it has actually loaded, so a slow or blocked image shows the
  // initials the whole time rather than an empty circle that fills in later —
  // or never.
  img.addEventListener("load", () => {
    initials.remove();
    accountChip.append(img);
  });
  img.src = profile.avatar;
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
    // The window only becomes known when the lineup lands, so the bar's first
    // honest render is here rather than at startup.
    refreshContextBar();
  };

  fill(
    stored
      ? [{ value: stored, label: shortModelName(stored) }]
      : [{ value: "", label: "Loading models…" }],
    stored,
  );

  try {
    lineup = await listModels();
    const options = optionsFor(lineup);
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
    const profile = profileOf(session.user);
    if (accountEmail) accountEmail.textContent = profile.label;
    // The account is stated in the HEADER, not only inside a drawer behind an
    // unlabelled icon. "How do I sign out" was a real question asked of this
    // panel, and the answer being two discoveries deep was the reason.
    renderAccountChip(profile);
    // Reopening the panel lands you back in the conversation you were having,
    // which is what a docked panel implies. A blank chat every time makes the
    // history list the only way back to work that was one click away.
    const [recent] = await listSessions();
    if (recent) {
      sessionId = recent.id;
      currentTitle = recent.title;
      messages = await loadSession(recent.id);
    }
    // Loaded before the first render so a reopened panel starts calibrated
    // rather than relearning the ratio on the user's first message.
    calibration = await loadCalibration();
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
    return;
  }
  // Escape abandons an edit. Without a way out, pressing Edit by accident
  // leaves the composer armed to delete the rest of the conversation.
  if (event.key === "Escape" && editingFrom !== null) {
    event.preventDefault();
    cancelEdit();
    if (input) input.value = "";
    setStatus("");
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

/* ── Closing the panel ────────────────────────────────────────────────────── */

/**
 * Closing the panel ENDS THE TURN, and it has to end it out loud.
 *
 * WHY THIS IS A MONEY BUG AND NOT A TIDINESS ONE. The loop runs in this
 * document, so closing the panel destroys everything rendering the answer — but
 * it does NOT, on its own, cancel the request. The proxy keeps streaming a turn
 * to a document that no longer exists, keeps metering it, and debits the user's
 * wallet for output nobody will ever read. The model also keeps DRIVING PAGES:
 * an un-aborted loop goes on clicking and filling in the user's real browser
 * after they closed the thing they were watching it through.
 *
 * `pagehide` rather than `beforeunload`: `beforeunload` is unreliable in an
 * extension document and is not guaranteed to run at all, while `pagehide`
 * fires on the path a side panel actually takes when it closes. Both are
 * registered anyway, and abort is idempotent — a signal that is already aborted
 * ignores a second call, so the cost of the belt-and-braces is nothing.
 *
 * The transcript is saved after every round, so what survives is everything up
 * to the last completed one. That is said out loud in the empty state rather
 * than discovered.
 */
function endTurnOnClose(): void {
  running?.abort();
  // The frame and the debugger banner outlive this document otherwise: the tab
  // keeps its green border and Chrome keeps announcing that Atlarix is
  // debugging the browser, both describing a turn that is over.
  void clearDrivenTabs("turn");
  void detachAll();
}

for (const event of ["pagehide", "beforeunload"] as const) {
  window.addEventListener(event, endTurnOnClose);
}

/* ── Attaching ────────────────────────────────────────────────────────────── */

attachButton?.addEventListener("click", () => attachInput?.click());

attachInput?.addEventListener("change", () => {
  const files = attachInput.files;
  if (files && files.length > 0) void stageFiles(files);
  // RESET, or picking the same file twice in a row fires no `change` event the
  // second time and the attachment silently does not appear.
  attachInput.value = "";
});

// Pasting a screenshot is how most images actually arrive in a browser panel.
input?.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  // Only when there are FILES. A paste carrying both text and an image — which
  // is what copying from a web page produces — must still paste the text.
  event.preventDefault();
  void stageFiles(files);
});

// Drag over anywhere in the panel; the composer is the target.
for (const type of ["dragenter", "dragover"] as const) {
  document.addEventListener(type, (event) => {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    composer?.classList.add("composer--dropping");
  });
}

for (const type of ["dragleave", "drop"] as const) {
  document.addEventListener(type, (event) => {
    if (type === "dragleave" && event.relatedTarget) return;
    composer?.classList.remove("composer--dropping");
  });
}

document.addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  // WITHOUT THIS the browser NAVIGATES THE PANEL to the dropped file, which
  // destroys the document the agent loop is running in — the turn dies and the
  // panel comes back as a PDF viewer.
  event.preventDefault();
  void stageFiles(files);
});

modelSelect?.addEventListener("change", () => {
  // A different tier is a different window, so the same transcript is a
  // different percentage. Switching from a 1M model to a 128k one is exactly
  // when someone needs to be told.
  refreshContextBar();
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
    // And the account's copy of them. `syncSiteGrants` publishes whatever is
    // left, which is now nothing, and the server drops the rows -- the same
    // "erase means erase" rule the conversations below are held to. Without
    // this the account page would keep listing sites for a browser that has
    // just erased them, with no way to tell it is wrong.
    await syncSiteGrants();
    const all = await listSessions();
    await deleteArchives(all.map((sn) => sn.id));
    // Erase means erase, including the copy on the account. Leaving those rows
    // behind would make "delete everything" a local gesture with a server-side
    // asterisk nobody was told about.
    await Promise.all(all.map((sn) => deleteRemoteConversation(sn.id)));
    await deleteAllSessions();
    // ENUMERATES THE PER-NOTE KEYS. The old store was a single key, so its
    // `forgetAll` removed one; with a key per note, clearing only the index
    // would leave every body on disk while the UI reported an empty store —
    // the orphaned-key trap `sessions/store.ts` already records for archives.
    await deleteAllNotes();
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
