/** Default chat turns (user+assistant pairs) sent to AI. Raised from 3 for better context (Phase 5). */
export const MAX_CHAT_TURNS_IN_CONTEXT = 10;

/**
 * Wall-clock cap for long-running multi-round workspace tool streams.
 * Applies regardless of chat tier (ask/build/agent), work mode (ask/plan/build/debug/review),
 * or agent mode (direct/guided/autonomous).
 */
export const STREAM_TOOL_LOOP_DURATION_CAP_MS = 30 * 60 * 1000;
