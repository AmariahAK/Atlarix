# Atlarix v12.9.0 — Discord technical post

> Paste-ready for the announcements channel. Crash fix follow-up to v12.8.

---

**Atlarix v12.9.0 released** 🛡️

Release notes (technical):

Two production fixes — the Terminal crash and the packaged system prompt.

- **Opening the Terminal no longer force-closes the app (macOS):** in packaged builds, clicking the right-panel Terminal tab could abort the whole process. The crash minidump symbolicated (lldb) to **keytar** — its prebuilt native binary throws an uncaught C++ `Napi::Error` on the main thread (`Napi::CallbackData::Wrapper` → `__cxa_throw` → `std::terminate` → `abort`) for certain macOS Keychain states. Because the abort happens *inside native code*, no JS `try/catch` (nor v12.8's `uncaughtException` handler) can catch it — the only fix is to stop calling keytar. keytar was the sole backend for the Supabase session store, which was being touched during a session read/refresh that coincided with opening the Terminal. Replaced it with Electron's built-in **`safeStorage`** (already the fallback here; raises catchable JS errors and can't abort the process). keytar is also deprecated/unmaintained, so it's now fully removed (dependency + native rebuild config). ⚠️ Session persistence moved to `safeStorage` — **you may be asked to sign in once more** after updating.
- **The packaged app now ships the full system prompt:** in production the agent silently ran on a degraded minimal fallback — `AGENTS.md` / `AGENTS_COMPACT.md` / `AGENTS_MODE_BASE.md` were never packaged (root-level files are excluded by the packager's `ignore` allowlist), so `system_prompt.ts` logged "AGENTS.md not found … using fallback minimal prompt". They now ship via `extraResource` (same mechanism as the built-in skill guides) and load from `process.resourcesPath` first when packaged. Dev was unaffected.

> The same keytar abort could also fire on any background Supabase token refresh — removing keytar closes that path too. v12.8's crash-hardening (`uncaughtException` handler + before-quit/secure-storage guards) stays as belt-and-suspenders but can't catch a native C++ terminate.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
