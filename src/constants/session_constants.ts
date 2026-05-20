/** Max messages loaded from SQLite when resuming a workspace session (~50 exchanges). */
export const SESSION_LOAD_MESSAGE_LIMIT = 100;

/** Max messages retained per session in SQLite (oldest pruned after insert). */
export const SESSION_STORE_MESSAGE_MAX = 200;

/** Max user+assistant exchanges shown in the chat UI (see sliceLastExchanges). */
export const SESSION_UI_MAX_EXCHANGES = 7;

/** Delay before showing the session loading overlay (avoids flash on fast loads). */
export const SESSION_LOAD_OVERLAY_DELAY_MS = 1000;
