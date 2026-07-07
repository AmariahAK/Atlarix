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
