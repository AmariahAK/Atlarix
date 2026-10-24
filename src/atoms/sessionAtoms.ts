import { atom } from "jotai";
import { isStreamingByIdAtom } from "@/atoms/chatAtoms";

export const activeWorkspaceSessionIdAtom = atom<string | null>(null);

/**
 * A session to open as if its row had been clicked, waiting for its
 * workspace's session list to mount and open it: one handed over from the CLI
 * (`/handoff app`, lib/peers), or a fork made from the composer (`/fork`).
 * `note` is what the toast says (the handoff's when absent).
 */
export const pendingSessionHandoffAtom = atom<{
  sessionId: string;
  workspaceId: number;
  note?: string;
  /** Opened from a desktop notification: no toast. */
  quiet?: boolean;
} | null>(null);

/**
 * The active session's stored work mode, or `null` when it has none.
 *
 * Hydrated when a session is activated and written when the user picks a mode in
 * it. `null` is meaningful — it means "this session has never had a mode chosen,
 * resolve from the global preference" — so it must never be collapsed to a
 * default here. `resolveEffectiveWorkMode` already treats an absent value that
 * way, which is what keeps every pre-existing session behaving as it does today.
 *
 * Deliberately keyed on nothing: it tracks the ACTIVE session only. A per-chat
 * map would be a second source of truth for something the DB already owns, and
 * the one thing this change is trying to end is a mode with two owners.
 */
export const activeSessionWorkModeAtom = atom<
  import("@/lib/schemas").WorkMode | null
>(null);

/** True when UI shows history from a loaded session but model context is empty. */
export const loadedSessionResumeAtom = atom<boolean>(false);

export const chatIdToSessionIdAtom = atom<Map<number, string>>(new Map());

/** Inverse map for reusing chat transport when switching sessions. */
export const sessionIdToChatIdAtom = atom<Map<string, number>>(new Map());

export const workspaceSessionLoadingAtom = atom<boolean>(false);

export const workspaceSessionLoadingLabelAtom =
  atom<string>("Loading session…");

export const loadedSessionTruncatedAtom = atom<boolean>(false);

/** Bump to reload workspace session lists after create/rename. */
export const workspaceSessionsRefreshAtom = atom(0);

/** Session ids currently awaiting AI-generated titles. */
export const workspaceSessionTitleGeneratingAtom = atom<Set<string>>(
  new Set<string>(),
);

/**
 * Session ids that have an active *background* stream — i.e. their chat
 * transport is streaming AND the forward/reverse session↔chat bindings agree
 * (so a stale forward entry can't mis-attribute a spinner to the wrong row).
 *
 * Derived so the sidebar can subscribe to just this membership Set instead of
 * the whole `chatIdToSessionId` reverse map, which churns on every streaming
 * tick and made the session list re-render far more than necessary.
 */
let prevBgKey = "\u0000"; // sentinel — never equals a real join("|")
let prevBgSet = new Set<string>();
export const backgroundStreamingSessionIdsAtom = atom<Set<string>>((get) => {
  const sessionToChat = get(sessionIdToChatIdAtom);
  const chatToSession = get(chatIdToSessionIdAtom);
  const streamingById = get(isStreamingByIdAtom);
  const result = new Set<string>();
  for (const [sessionId, chatId] of sessionToChat) {
    if (!streamingById.get(chatId)) continue;
    // Reverse-map consistency: the chatId must still map back to this session.
    if (chatToSession.get(chatId) !== sessionId) continue;
    result.add(sessionId);
  }
  // Return a stable reference when *membership* is unchanged so the derived
  // value's identity doesn't churn every time the underlying maps are rewritten
  // mid-stream (single default store — see app architecture).
  const key = [...result].sort().join("|");
  if (key === prevBgKey) return prevBgSet;
  prevBgKey = key;
  prevBgSet = result;
  return result;
});
