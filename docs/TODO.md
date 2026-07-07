# Atlarix TODO

**Current Version:** v14.8.11 (2026-07-04)
**Last Updated:** 2026-07-07

## ✅ Implemented, pending owner smoke + release

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[Unreleased]`.

- **Native-git reads + Code-tab removal + universal language (2026-07-06).** Local git ops are
  native-git-only (production Sentry `null.slice` fix; `enableNativeGit` deleted); Code tab + Monaco +
  QuickFileOpen deleted; ctags allowlist → auto-detect + 2 MB guard (ctags-only blueprint, no null
  cliff); ast-grep / blast-radius / dead-blueprint-chain pruned (−7851 lines, watcher →
  `search-index-watcher.ts`). vitest 1578.
- **Automations SHIPPED (2026-07-06).** Migration 0066; cron (node-cron) + GitHub-poll + MCP-poll
  triggers (deterministic, no LLM in loops); unattended runs via the headless spine (dangerous always
  denied, 10-min budget, concurrency 1); read-only default + opt-in worktree-write proposals; triage
  feed tab. vitest 1600.
- **`chat_stream_handlers.ts` decomposition COMPLETE (2026-07-07).** God-file **7984 → 2364 lines
  (−70%)**; `runStream` is now a thin orchestrator over 8 `chat_stream/turn-runner/*.ts` modules
  (simple-stream-text, round-retry, response-chunk-update, context-assembly, ask-branch, build-branch,
  finalize, prompt-bundle). Every extraction body-verbatim + separately gated (ts + oxlint +
  per-project agent-evals 73 / node 1484 / renderer 58). **Smoke focus:** the context-overflow →
  `handleTurnError` rerun recursion path is NOT eval-covered — force a mid-turn overflow-compaction retry.

---

## Open follow-ups

- **BUG: not every approval wait is truly indefinite — some paths time out.** The contract: EVERY
  human-in-the-loop wait (command / file-write approval, `ask_user`) blocks INDEFINITELY. Audit for a
  hidden AI/tool-side timeout: `waitForApproval`, the run_command permission queue, `ask_user`, MCP
  auth/consent, and any `AbortSignal.timeout`/`setTimeout` race. Fix = wait until the user (or Stop)
  resolves. [[atlarix-command-safety-model]]
- **BUG: model reports a background command "done" while it's still running.** Observed on DeepSeek —
  polls the job, narrates "waiting", then prematurely claims completion (once marked plan steps done)
  before the background `run_command` exited. Determine the layer — (a) prompting, (b) harness
  (wake-on-exit / is the exit result re-injected before the model concludes?), (c) DeepSeek — then fix there.
- **BUG: Shift+Tab mode switch dropped while the app is busy.** The mode-cycle keybind (Build ↔ Explore
  ↔ Plan ↔ Debug ↔ Review) is unreliable while typing in the composer or during an in-flight stream,
  unlike Claude Code. Likely a focus/idle-gated binding. Fix = make it global + always-live.
- **BUG: the stale "vision model" gate blocks attached images.** Modern non-vision-tagged models
  (DeepSeek v4 pro / 3.2, Qwen 3.7 / 3.6 plus) read browser screenshots in-app AND images on the
  vendors' own web UIs, but Atlarix's *attach* path fails for them — screenshots ride the tool-result
  media path while attachments only embed "on vision dispatches" (gated on the models.dev vision tag).
  Fix = deliver attachments the way the working screenshot path does, for every model that can actually
  see, not just tagged ones. Verify by diffing both outbound requests on a live DeepSeek/Qwen run.
  [[atlarix-v14-8-11-fidelity-release]]
- **FEATURE: notification sound when Atlarix needs the user.** Audible (+ OS notification when
  unfocused) whenever a turn enters a waiting-on-user state (approval / `ask_user`). A setting (on/off,
  volume), respect OS DND, no double-fire with the Automations notifications. Open: owner supplies a
  sound asset or Claude sources/generates one (owner fine with either).
- **CONSIDER (evaluate, don't commit): `browser-use` repo/extension vs. our current browser tools.**
  Compare element-targeting reliability, page representation (a11y tree/DOM vs. our snapshot-first
  visual sight), token cost, whether it needs a separate Python runtime (bad fit for Electron), and
  approval/sandbox integration. Migrate only if a clear win; else close the note. [[atlarix-preview-webcontentsview]]
- Small / carried: `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor
  credit (owner action; code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via read_attachment).
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase
  (@ai-sdk/anthropic MUST stay 2.x w/ ai@5 [[atlarix-ai-sdk-version-trap]]; zod mid-v4; 3 patch-package
  patches; ABI-pinned better-sqlite3/node-pty/keytar). Worklist = `npm outdated` (direct) + `npm audit`
  + own deprecated-API usage + CI action EOLs; leave pinned/transitive with a note.

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
