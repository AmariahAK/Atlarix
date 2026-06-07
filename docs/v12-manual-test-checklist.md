# v12.0.0 manual-test checklist (before tagging)

The automated gate is green (55 agent-evals, 1165 unit/renderer tests, ts/lint/knip clean, boot smoke per session). This checklist covers what automation **cannot** verify: real providers, real repos, wall-clock feel, and packaged builds. Work through it on a dev build (`npm start`), then spot-check a packaged build before `git tag v12.0.0 && git push origin v12.0.0`.

## 1. Engine parity (the rewrite risk surface)
- [ ] One full turn in each mode — Explore, Plan, Build, Debug, Review — on a real workspace; responses stream, tools run, turns end cleanly.
- [ ] Plan mode: ask for a plan → `write_implementation_plan` fires → plan card renders → "Plan saved" activity appears.
- [ ] Build: multi-file edit with approvals → approve some hunks, reject others → files on disk match decisions.
- [ ] `ask_user`: the question card renders, the turn ENDS, answering resumes; typing something else instead also works.
- [ ] Abort a streaming turn mid-tool; the partial response is saved and the next turn works.

## 2. Native history + prompt cache (0.2)
- [ ] Multi-turn Build conversation on Anthropic BYOK: check the main log for `[prompt-cache]` reads on turns 2+ (cache holding = the rewrite's cost win).
- [ ] Reload the app mid-conversation → continue the conversation → the model still sees earlier tool results (native replay across reload).
- [ ] `browser_screenshot` on a vision model: the model describes what's actually in the screenshot.

## 3. Edit-verify gate (0.3)
- [ ] With `enableAutoFixProblems` ON: ask for a change that plausibly breaks types → watch the model receive `<diagnostics>` feedback and fix before completing.
- [ ] Toggle OFF → no LSP feedback round.

## 4. Permissions, hooks, rulesets (2.2 + S16)
- [ ] Workspace `.atlarix/permissions.json` `{"deny": ["run_command(rm *)"]}` → ask the agent to `rm` something → structured denial, NO approval prompt.
- [ ] Global `~/.atlarix/permissions.json` deny → same enforcement with no workspace file.
- [ ] `.atlarix/hooks/hooks.json` stop hook that fails → `task_complete` is blocked, the model is told why, a passing fix releases it.
- [ ] Settings → AI: the Hooks section shows the file-based pointer (the old DB-hooks editor is gone — release-note behavior).

## 5. Background agents (2.3 + S16)
- [ ] Start a read-only background agent (IPC/dev tools: `agents:background:start`) → Agents tab auto-surfaces → status reaches done → session opens with the result.
- [ ] Write-mode agent → finishes with changed files listed → **revert** removes them / **keep** leaves them.
- [ ] Write-mode agent → finish → QUIT the app → relaunch → revert still works (S16 restart fix).
- [ ] Cancel a running agent.

## 6. Capability profiles (2.1)
- [ ] A small local model (e.g. a 7B on Ollama): the log shows `[capability] … toolset trimmed`, and the model can still read/write/run.
- [ ] A strong model gets the full surface (no trim log).

## 7. Blueprint v2 (Tier 6 + S20)
- [ ] `get_blueprint` on a real monorepo section with a `topic` — relevant rooms rank first; signatures render.
- [ ] On a repo with heavy method/dynamic calls: the "~N call sites use member/computed callees" note appears.
- [ ] A small, well-modularized Python repo parses with symbols (not file-tree fallback).

## 8. TTFT — the wall-clock verification (S17/S18)
- [ ] On the LARGEST real workspace you have, on Atlarix Core: send a prompt, grep the log for `[perf] preflight-breakdown` — record `total=` and the per-step spans.
- [ ] Compare against the pre-v12 feel (the bug report was ttft≈15.9s). Expect the section loads to overlap (the breakdown's `accounted` ≫ wall-clock for the load block) and total pre-flight well under the old number on a warm workspace.
- [ ] If one span dominates, file it — S18 consciously deferred per-mode deferral pending real numbers.

## 9. Packaged build
- [ ] `npm run package` → launch the packaged app → open a workspace, run one Build turn with an approval.
- [ ] Check installed size is in family with v10.1 (the 1.28GB regression class is guarded by the packageAfterPrune rewrite, but measure once).
- [ ] Migration: launch packaged app against an EXISTING userData (your real profile backup) → `Applying embedded migration: 0061_background_agent_meta` in the log, sessions intact.

## 10. Release mechanics (after everything above)
- [ ] `ATLARIX_CORE_MODEL_1..4` secrets present in repo settings (legacy `COMPASS_MODEL_*` fallback covers 1–3 only).
- [ ] `npm run verify:lockfile` clean.
- [ ] Tag: `git tag v12.0.0 && git push origin v12.0.0` → Actions → quality gates → 3-OS build → publish to atlarix-releases.
- [ ] After publish: update launchpad copy/download links if the release notes call out v12 features.
