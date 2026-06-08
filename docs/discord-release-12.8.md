# Atlarix v12.8.0 — Discord technical post

> Paste-ready for the announcements channel. Stability follow-up to v12.7.

---

**Atlarix v12.8.0 released** 🛡️

Release notes (technical):

Three production fixes — two bugs and a crash-hardening pass.

- **No more "Chat not found: -1":** a debounced token-count request could fire for a chat that was just torn down (session deleted / app teardown), and the handler threw `Chat not found` — surfacing as a user error toast and a Sentry event. Token count is a non-critical estimate, so a missing ephemeral chat now returns an empty result instead of throwing (`token_count_handlers.ts`).
- **Deleting the active session no longer drops you to the workspace selector:** `handleDelete` cleared the active session but never started a replacement, so deleting the active/last session fell back to the welcome screen. It now opens a fresh session in the **same** workspace (reusing an empty default session when one exists) via `startNewWorkspaceConversation`. Deleting a background session leaves your current view unchanged.
- **Crash hardening (fatal native aborts):** the main process had no `process.on("uncaughtException")` handler, so an uncaught error (a native-addon throw, or a JS error outside a promise) reached the runtime and triggered `std::terminate()` — a hard abort that crashed the window and lost work (fatal minidumps in Sentry). Added an `uncaughtException` handler that reports to Sentry (respecting the v12.7 filters) and keeps the app alive, mirroring the existing `unhandledRejection` policy. Also wrapped the `before-quit` flush chain in `try/finally` (always quits) and guarded the unwrapped native `safeStorage.encryptString` write.

> Note: the minidump can't be reproduced from its stack alone — the `uncaughtException` handler converts the abort into a reported, survivable event, so if it recurs we'll have a real JS stack to act on. Known follow-up tracked in `docs/TODO.md`: plan tools failing when a stream transport loses its workspace-session binding.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
