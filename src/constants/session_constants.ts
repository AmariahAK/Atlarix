/**
 * Max messages loaded from SQLite when resuming a workspace session.
 *
 * Set deliberately high so the FULL conversation loads on open (parity with
 * opencode / claude-code, which keep full scrollback). The renderer renders the
 * whole history (memoized rows) instead of a fixed window, so there is no
 * "last N exchanges only" cutoff. The value is a sanity ceiling, not a UX cap.
 */
export const SESSION_LOAD_MESSAGE_LIMIT = 100_000;

/**
 * Safety ceiling for messages retained per session in SQLite.
 *
 * Raised far above any realistic session so history is NEVER silently deleted
 * (the old 200 cap caused real data loss — exchanges vanished on long tasks,
 * worsened by the duo-stream race). Kept only as a runaway backstop.
 */
export const SESSION_STORE_MESSAGE_MAX = 100_000;

/** Delay before showing the session loading overlay (avoids flash on fast loads). */
export const SESSION_LOAD_OVERLAY_DELAY_MS = 1000;
