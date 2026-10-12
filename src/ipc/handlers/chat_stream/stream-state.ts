/**
 * Shared per-chat streaming state for the chat:stream handler — the Maps, the
 * ActiveStreamRegistry, the monotonic stream-id counter, and the captured
 * handler ref. Previously module-level state inside chat_stream_handlers.ts;
 * extracted so the satellites and the register function can both reach it
 * without the god-file owning it.
 *
 * (Satellite: never imports the parent handler — keeps the run-agent-turn
 * cycle-avoidance intact. The parent and the coupled satellites both import
 * FROM here.)
 *
 * `let`-style state (the id counter, lastSkillCacheAppId, the handler ref)
 * cannot be reassigned through an ES import binding, so it is exposed via
 * accessor functions rather than a mutable export.
 */

import type { ModeSystemKey } from "@/prompts/system_prompt";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import { readSettings } from "@/main/settings";
import {
  acquirePowerSaveBlocker,
  releasePowerSaveBlocker,
  resetPowerSaveBlocker,
} from "@/ipc/utils/power-blocker";

// Legacy: Ask->Build approval wait (unused on request_mode_change tool path; respond-mode-change may still resolve)
export const pendingModeChangeResolvers = new Map<
  number,
  { finish: (approved: boolean) => void }
>();

/** Questions captured at end-turn time so the persist path can embed them. */
export const pendingAskUserArtifactByChatId = new Map<
  number,
  import("@/lib/chat/ask-user-artifacts").AskUserArtifact
>();

// Track active streams for cancellation.
//
// Subclasses Map so every set/delete/clear drives the power-save blocker in one
// place — no matter which of the ~14 delete sites fires. The blocker keeps the
// CPU alive while a stream is in flight so tasks keep progressing when the
// display sleeps (see power-blocker.ts).
export class ActiveStreamRegistry extends Map<number, AbortController> {
  /** chatIds that actually took a blocker ref — so release can't drift if the
   * keepAwakeDuringRuns setting is toggled mid-session. */
  private acquired = new Set<number>();

  override set(chatId: number, controller: AbortController): this {
    const isNew = !this.has(chatId);
    super.set(chatId, controller);
    if (isNew && readSettings().keepAwakeDuringRuns !== false) {
      this.acquired.add(chatId);
      acquirePowerSaveBlocker();
    }
    return this;
  }

  override delete(chatId: number): boolean {
    const existed = super.delete(chatId);
    if (existed && this.acquired.delete(chatId)) releasePowerSaveBlocker();
    return existed;
  }

  override clear(): void {
    super.clear();
    this.acquired.clear();
    resetPowerSaveBlocker();
  }
}

export const activeStreams = new ActiveStreamRegistry();

// ─── Bug A: single-flight stream guard ─────────────────────────────────────
// Abort is COOPERATIVE — runAgentTurn only checks signal.aborted at loop tops,
// so a superseding stream can overlap an in-flight one and two turns end up
// writing the same workspace ("someone is changing the code"). We track the
// live runStream() PROMISE per chat so a new dispatch can await the prior
// leg's real termination (not just abort it) before starting, plus a monotonic
// id stamped on terminal events so the renderer drops a stale leg's late end.
export const activeStreamRuns = new Map<number, Promise<unknown>>();
export const activeStreamId = new Map<number, number>();
let __streamIdCounter = 0;
/** Next monotonic stream id (imports can't mutate a `let`, so wrap the counter). */
export function nextStreamId(): number {
  return ++__streamIdCounter;
}
export const SUPERSEDE_AWAIT_TIMEOUT_MS = 8_000;

// ─── System-wake admission control ─────────────────────────────────────────
//
// A system wake (finished background job, sub-agent result, scheduled self-wake,
// auto-self-correct) exists only to deliver a result to an IDLE chat. It must
// never interrupt a live turn and never resurrect a chat the user stopped.
//
// This has to live in MAIN. The renderer already had all three guards — "is this
// chat streaming", "is a wake already in flight", "did the user stop this chat" —
// but every one reads a per-window jotai store or a per-hook `useRef`, while the
// listener that triggers a wake keys on the chat id carried in the EVENT. So a
// second window received a job-finished event for a chat it had never seen, found
// nothing in its own store, concluded "not streaming", and woke a chat the first
// window was mid-turn on. Main supersedes; the superseded turn's end fires the
// other window's race-closer; repeat. 80 superseded turns in six minutes, the
// interval growing each round as the discarded turns lengthened the history.
//
// The lesson worth keeping: a decision that is global — may this chat start a
// turn? — cannot be made from per-window state, however carefully it is guarded.

/**
 * Chats the user has STOPPED, until they send something with real content.
 *
 * Mirrors the renderer latch it now backs (`useStreamChat`), for the reason
 * recorded there: cancel kills only foreground commands, so a pending background
 * result is normal right after a Stop — and a wake then started a turn that knew
 * nothing about the stop, re-read the file it had just edited, took its own change
 * for the user's, and carried on (observed: as far as `git push`).
 *
 * A latch, not a time window: set on a user cancel, cleared only when the user
 * actually sends something. No interval to tune, no race to lose.
 */
const userStoppedChats = new Set<number>();

export function markChatUserStopped(chatId: number): void {
  userStoppedChats.add(chatId);
}

/** Called when a request carries real user content — the user is driving again. */
export function clearChatUserStopped(chatId: number): void {
  userStoppedChats.delete(chatId);
}

export function isChatUserStopped(chatId: number): boolean {
  return userStoppedChats.has(chatId);
}

/** Why a system wake was refused — surfaced to the caller and the log. */
export type SystemWakeDropReason = "already-streaming" | "user-stopped";

/**
 * Should this `chat:stream` request be DROPPED rather than started?
 *
 * Pure, and exported for the test that pins it: the whole failure mode was a
 * guard that looked right and answered from the wrong process.
 *
 * Only system wakes are ever dropped. A user turn always proceeds and supersedes
 * whatever is running — that is the user redirecting the agent, which must keep
 * working.
 */
export function shouldDropSystemWake(
  req: { systemWake?: boolean },
  state: { isStreaming: boolean; userStopped: boolean },
): SystemWakeDropReason | null {
  if (!req.systemWake) return null;
  // Streaming first: it is the common case and the more informative reason.
  if (state.isStreaming) return "already-streaming";
  if (state.userStopped) return "user-stopped";
  return null;
}

/**
 * Should this request RELEASE the user-stop latch?
 *
 * Pure, and exported for the test that pins it — for the same reason
 * `shouldDropSystemWake` is: the failure mode was a guard that looked right.
 *
 * The rule is "the user is driving again", and `systemWake` is the property that
 * actually expresses it. The previous rule was `prompt.trim().length > 0`, whose
 * goal was right (a wake's empty prompt must not clear its own suppression) and
 * whose discriminator was wrong: several USER actions send an empty prompt
 * because their content travels out of band — answering `ask_user` (the answers
 * are persisted as their own message) and clicking Continue on an interrupted
 * turn.
 *
 * Consequence, observed 2026-09-03: one `ask_user` round latched a chat
 * `user-stopped` permanently. Closing the question flow aborts the stream, which
 * latches the stop; the empty-prompt answer turn could not clear it. Five
 * sub-agents finished over the following five minutes and every wake was dropped,
 * so their results waited for the user to TYPE. Commands, automations and
 * scheduled self-wakes all lose eager delivery the same way.
 */
export function shouldClearUserStopLatch(req: {
  systemWake?: boolean;
}): boolean {
  return !req.systemWake;
}

/** Is a turn live for this chat? The authoritative, cross-window answer. */
export function isChatStreamLive(chatId: number): boolean {
  return activeStreams.has(chatId) || activeStreamRuns.has(chatId);
}

/** Clear skill file cache when switching workspace (see `loadSkill`). */
let lastSkillCacheAppId: number | undefined;
export function getLastSkillCacheAppId(): number | undefined {
  return lastSkillCacheAppId;
}
export function setLastSkillCacheAppId(appId: number | undefined): void {
  lastSkillCacheAppId = appId;
}

// Track partial responses for cancelled streams
export const partialResponses = new Map<number, string>();

// ─── FIX 4: stream reconnect plumbing ──────────────────────────────────────
// Last successful `chat:stream` request per chat. Re-dispatched when the
// renderer fires `chat:stream:reconnect` after the auto-retry sequence ran
// out. Cleared on chat delete is unnecessary; entries are overwritten on the
// next normal `chat:stream` invocation for the same chatId.
export const lastStreamRequest = new Map<number, ChatStreamParams>();

// ─── Issue 4: crash-safe interrupted-turn recovery ─────────────────────────
// While an assistant turn streams we throttle-write the accumulated text into a
// single "interrupted" session_messages row per chat. If the app is killed,
// suspended, or the stream is aborted before completing, that row survives so
// the session can render the partial output with a "Continue" affordance. On
// clean completion the draft is deleted — the renderer persists the finished
// message instead.
export const partialDraftRowByChatId = new Map<number, string>();
export const partialDraftLastFlushAtByChatId = new Map<number, number>();
/** chatId → workspace sessionId, so shutdown flush can resolve the session without a req. */
export const streamSessionByChatId = new Map<number, string>();
/**
 * chatId → the live turn's snapshot/ledger turn id.
 *
 * The stream's own terminal payload carries this (`snapshotTurnIdForTerminal`), but
 * `chat:cancel` lives in a different handler with no view of the running turn, so its
 * `response:end` omitted it — and the renderer's Revert affordance is gated on having
 * received it. Net effect: you stop a turn because it made a bad edit, the snapshot is
 * sitting on disk, and the UI offers no way to use it. This map is what lets cancel
 * report the id too.
 */
export const streamTurnIdByChatId = new Map<number, string>();
/**
 * chatId → the running round's FINISHED steps (native tool call + result pairs).
 * Earlier rounds are folded into the turn's native envelope as they end; the
 * round a user stops is not, so without this a stopped turn kept only its text
 * and the model believed it had done nothing (QA, 2026-10-13: "Zero. No
 * read_file call had executed" after eight reads).
 */
export const liveRoundStepsByChatId = new Map<
  number,
  { turn: string | undefined; steps: () => import("ai").ModelMessage[] }
>();
/** #15: chatId → the work mode of that chat's PREVIOUS turn, to detect a switch
 * and fire a "mode changed" re-anchor. In-memory per chat (a restart just skips
 * the "changed" note on the first turn — the plain re-anchor still fires). */
export const lastTurnModeByChat = new Map<number, ModeSystemKey>();
export const PARTIAL_DRAFT_FLUSH_INTERVAL_MS = 1500;

/**
 * v12 2.3: the registered `chat:stream` handler, captured at registration so
 * background agents can invoke the SAME turn engine in-process with a
 * synthetic recording sender (no foreground renderer). Null until registered.
 */
export type ChatStreamHandlerFn = (
  event: Electron.IpcMainInvokeEvent,
  req: ChatStreamParams,
) => Promise<{ streamId: number } | { error: string } | void>;
let chatStreamHandlerRef: ChatStreamHandlerFn | null = null;

/** The live `chat:stream` handler for in-process automation runs (null before registration). */
export function getChatStreamHandler(): ChatStreamHandlerFn | null {
  return chatStreamHandlerRef;
}
/** Captured by the register function (imports can't reassign a `let`). */
export function setChatStreamHandlerRef(fn: ChatStreamHandlerFn | null): void {
  chatStreamHandlerRef = fn;
}
