# Atlarix TODO

**Current Version:** v14.30.0 (2026-08-11) — on-device dictation works on Windows and Linux
(the CPU fallback had never built a session on any platform).
**Last Updated:** 2026-08-11

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative. That lives in [`docs/CHANGELOG.md`](./CHANGELOG.md)
> (and `docs/CHANGELOG_PREVIOUS.md`), with a one-line index per version at the bottom of this
> file. The file had drifted to 1,194 lines, ~810 of them retrospectives duplicated in the
> changelog; trimmed 2026-08-11. Nothing was lost — `git log -- docs/TODO.md` has every word.

---

## 🚧 Needs the Windows machine

The one place several things can only be confirmed. Grouped so a single Windows session clears
them all.

### v14.30.0 — on-device voice on the CPU path
- [ ] Install the release and dictate. **Success is the log**
      (`%APPDATA%\Atlarix\logs\main.log`): `loading onnx-community/whisper-small on … (dtype=q4)`,
      then `model ready on device=webgpu` **or** `device=wasm` — **either is a pass**, and `wasm`
      is the more valuable result because that is the path that was broken. Then a
      `transcript(N chars)` line.
- [ ] **Must NOT appear:** `MatMulNBits`, `Missing required scale`, `stopped downloading`.
- [ ] Confirm the download is ~285 MB (not ~800 MB) and the mic is **clickable while it
      downloads**.
- [ ] Same on Linux, which has never been tested and now takes the same WebGPU-first path.

### Windows sandbox (Low IL) — from the v14.28.0 rebuild
- [ ] `run_command` must succeed with git under Low IL. **This is the whole point.**
- [ ] `--self-test` → expect **8 probes** including `sandbox`; confirm an **info**-level
      `Sandboxing run_command` line (it was `debug`, so only failure was ever visible).
- [ ] Confirm `CreateProcessAsUserW` succeeds unprivileged. If it returns
      `ERROR_PRIVILEGE_NOT_HELD (1314)` the probe will report the sandbox unusable and
      commands run unconfined — at which point implement Codex's model.

### MSIX / Store build
- [ ] Run the spike (`docs/MSIX_RUNBOOK.md` §4). **Baseline on Squirrel FIRST** — a failure
      inside MSIX is otherwise unattributable.
- [x] **A Squirrel → Store reinstall keeps the user's data — verified manually by the owner,
      2026-08-12.** The concern was that if `userData` diverged inside the package container, a
      Squirrel user switching to the Store build would silently get a fresh profile (no
      workspaces, chats or credentials) and need a one-time migration. It does not diverge, so
      **no migration is needed** and it is safe to tell users to uninstall and reinstall from
      the Store — which the 2026-08 outreach email now does.
      *Checked by hand rather than by the `context` probe, so the exact path string is still
      unrecorded; if you ever want it in the log, that is the one remaining piece.*
- [ ] Confirm the manifest protocol declaration works (OAuth sign-in) and that
      `atlarix://pro-return` completes a Lemon Squeezy purchase.

---

## ⏳ Open / deferred

- **The CSP does not reach the whisper worker.** `installContentSecurityPolicy()`
  (`main.ts:304`) is enforced on the `file://` document — verified: `eval()` and inline scripts
  are refused there — but a dedicated worker loaded from `file://` does **not** inherit it, and
  `eval()` runs freely inside the worker. So A13/M-6 does not cover `whisper-worker`, and the
  `'wasm-unsafe-eval'` in the policy is not what lets ONNX compile. Low urgency (the worker runs
  our own bundled code and fetches from HF only), but the comment on that function claims
  coverage it does not have.
- **Configurable read-deny patterns, opencode-style** — no built-in list, no defaults; the user
  declares their own (`read: { "<pattern>": "ask" | "allow" | "deny" }`). Chosen over Codex's
  model (which ships defaults for `.env*`, keys, `.aws/credentials`, `secrets/**`) because it
  keeps `src/lib/tools/glob.ts:221` intact — that line already records the deliberate decision
  that *"in-workspace files (incl. .env) are enumerable"*.
  **Caveat that dominates the estimate:** the config is the easy half. A deny-read is only real
  if `run_command` cannot `cat` the file. macOS Seatbelt takes `(deny file-read* …)` and Linux
  Landlock takes read rights in the handled set — both cheap. **Windows Low IL cannot**: MIC is
  `NO_WRITE_UP`, so reads up are allowed by design. It would need a `NO_READ_UP` label per
  protected file (persistently mutating the user's files) or tool-level checks only, which
  `run_command` bypasses. Ironically the AppContainer we removed *could* deny reads — that is
  exactly why it broke. Scope as tool-level enforcement everywhere + sandbox-level on
  macOS/Linux + a documented Windows gap.
- **Landlock `ABI::V5` (`IoctlDev`)** once there's a compatibility test for device ioctls.
- **`proxy-worker` self-test probe can't run from source:** `start_proxy_server.ts:30` resolves
  `__dirname/../../worker`, which is right in the packaged build and wrong under vitest. Covered
  meanwhile by `src/__tests__/proxy-passthrough.test.ts`.
- **Packaging registry (one line, deliberately deferred).** `runNpmInstall`
  (`forge.config.ts`) spawns npm with no `--registry`, in `buildPath` outside the project, so a
  custom global registry wins and `packageAfterPrune` dies with `E401`. Until it lands,
  `npm run package` needs `npm_config_registry=https://registry.npmjs.org/`. Held pending the
  owner's account migration.
- **Sub-agent results still don't *continue* in the timeline** — STILL OPEN, deliberately not
  attempted. The painful half is gone: results RENDER properly (markdown, with a real `task`
  tool card) instead of as a raw envelope slice. What remains is purely placement — they live
  inside the round-panel cards behind the expand affordance rather than resolving inline where
  they were spawned. Direction unchanged: weave settled `subagent` items via
  `weaveIpcItemsIntoParts` (`WEAVABLE_KINDS` currently excludes `subagent_round` — "panels/rounds
  always stay tail") and collapse the panel once all agents settle, so the same agent isn't
  rendered twice.
  - **Why it keeps being skipped:** its entire value is visual placement, and it sits in the most
    reflow-sensitive code in the renderer — `AssistantMessageBody`'s sticky-agents / seam-offset /
    synthesized-round interaction, which has already produced one "scratchy rendering" regression
    from the panel unmounting mid-stream (fixed in v14.23.0 by gating collapse on `!isStreaming`).
    The v14.23.0 parity test guards trailing-element *duplication*; nothing guards "does it look
    right". Land it in a session that starts with the packaged app open, so each step is seen
    rather than inferred.

### Checked and CORRECT as-is — do not "fix" these

From the 2026-08-05 hardcoding sweep. The distinguishing test in every case is *what happens
when the list is incomplete*.

- **`defaultWritablePaths`** (`lib/sandbox/wrap-command.ts`) — a curated ~18-entry home-cache
  list beside a dynamic env-var half. It is a *write* allowlist: an incomplete entry fails
  CLOSED (a denial the escalation flow then offers to grant). Making it dynamic — probing
  `$HOME` for dot-dirs — would WIDEN the sandbox. Curated is the correct posture.
- **`DANGEROUS_PATTERNS`** / **`SYSTEM_SCOPE_PATTERNS`** — UX gates, not boundaries.
  system-scope says so outright: "best-effort — the sandbox catches anything not listed here."
- **`DENIAL_PATTERNS`** — extracts a path from tool prose (a positive capability); a miss now
  degrades into `sandbox-failure-context.ts` rather than into silence.
- **Browser error capture** (`lib/browser/error-hook.ts`) — filters on the browser's own console
  `level` and HTTP status ≥ 400, never on curated message strings. Already derived.
- **`file-permission-scope.ts`** — the v14.23.0 protected-path deletion has NOT crept back; what
  remains is a set of Atlarix's own operation names, which we control.
- **`models_dev.ts` / provider dispatch** — de-hardcoded in v14.23.0; only the documented
  deliberate pins remain.
- Browser `KEY_ALIASES` / `MODIFIER_TOKENS` — a closed set from the DOM spec, not an ecosystem
  that grows.

---

## 🔜 Blocked on the owner — NOT active work

Kept for the record; none of these can be picked up in a coding session.

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI (release-infra, no
  cert). OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in,
  reverted; the flow-in-progress gate stays).
- **Billing A/B (owner-side):** confirm OpenRouter `usage.cost` includes the ~$0.005 search fee so
  the wallet debit = `ceil(cost × 1.4)`; else add a proxy surcharge in
  `atlarix-proxy/src/server.ts`.
- **DB shutdown-race stress-verification** on a packaged build (shutdown-guard committed, not
  stress-verified). *(The voice half of this entry is done — verified in the packaged app
  2026-08-11; what remains is Windows/Linux, tracked above.)*
- **Dependency deprecation triage** is its own release; see below and treat it as roadmap, not
  queue.

---

## 🔎 Recorded — not scheduled

- **The Dyad-era hosted-engine subsystem is orthogonal to the current architecture, and it is an
  OWNER decision whether it is still a product.** Traced while unthreading the always-empty
  `files` array: `get_model_client.ts:170-221` branches to `createAtlarixEngine` at
  `https://engine.atlarix.dev/v1` whenever `settings.enableAtlarixPro` is set — and that toggle
  is still live user-facing UI at `ProviderSettingsPage.tsx:414`. Hanging off it:
  `llm_engine_provider.ts`, lazy edits, smart-files context, deep context, and the git-history
  half of `versioned_codebase_context.ts` (which is why that file was KEPT — its second loop does
  real work, reading paths named in past assistant turns back out of git at the commit they
  recorded). None of this relates to Core-as-prepaid-wallet-through-the-proxy. Not a
  coding-session call.
- **`selectedComponents` still flows renderer → IPC → `ChatStreamParams` and is read by nothing on
  the main side.** Same Dyad-era shape; unpicking it crosses into the renderer and belongs with
  the decision above.

---

## 🔐 Security follow-ups (from `docs/SECURITY_REVIEW_v14.8.12.md`, owner-triaged)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF +
pro-return confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP description
wrapping + OAuth-URL validation, the **universal write-confining sandbox** (Win AppContainer +
Linux Landlock bundled — Windows since rebuilt on Low IL, v14.28.0), and the **system-scope
approval gate** (which also closed M1 — cwd `allowedRoots` widening is now gated on interactive
approval). **Deferred (tracked):**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (code-signing certs + `app-update.yml` for NsisUpdater; out-of-band signature for
  AppImage), not app code. Owner chose NOT to gate the public release on it. (Windows helper sign
  step is already wired — set the cert secret to enable.)
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS.
  `npm run check:sandbox` now cross-target type-checks both in the `quality` job, and the helpers
  are gated on behaviour rather than compilation alone — but neither is a substitute for running
  them on the real OS.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the denylist
  taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL allowlist
  permits a query param (current gate = flow-must-be-in-progress).
- Sandbox **read**-confinement (see the read-deny entry above for why Windows is the blocker),
  model-context **secret redaction**, **egress** gating, and the remaining Medium items (env-var
  key inheritance, secret-basename list, cross-workspace file scope, plaintext-keychain fallback).

---

## 📋 Carried / small

- **CONSIDER (evaluated → CLOSED): `browser-use`.** Not adopted — Python/Playwright (bad Electron
  fit), it's its own agent loop, and its one good idea (stable element refs) Atlarix already has
  via `browser_inspect` snapshot `ref`s. No capability gap.
- **CONSIDER (evaluated → REFERENCE ONLY): `h5i`** (`github.com/h5i-dev/h5i`, Apache-2.0).
  A standalone Rust CLI that sandboxes AI coding agents in tiers (workspace / process /
  supervised / container / microvm). Not adoptable: it is a peer harness, not a library, and its
  leverage is Linux — its `process` tier is Landlock + seccomp + namespaces, which we already
  ship natively, while Windows (Low IL) and macOS (Seatbelt) get nothing from it. Container and
  microvm tiers would require users to install Podman or have `/dev/kvm`. **Worth borrowing:** the
  tier vocabulary, and its `supervised` tier — private netns + nftables egress allowlist — which
  is a capability we lack and is distinct from write confinement. Also its honest framing:
  *"It cannot stop an agent from putting your code in a prompt. Containment keeps the agent off
  your machine. Model egress is a separate control."*
- **No test measures whether our own suite is sensitive.** No mutation testing, and no eval
  scenario where the fixture repo's suite is deliberately wrong or incomplete — so "tests pass"
  is a claim about the suite, not about the change. v14.30.0 produced two clean instances: unit
  tests that asserted the *wrong* dtype diagnosis and passed, and 2,782 green tests plus a
  successful local package that still shipped a Windows-only packaging break. Candidate: eval
  fixtures whose suite is a trap (passes while asserting the wrong invariant; 100% pass with zero
  coverage of the changed path; tautological assertion), scored on whether the agent *says* the
  suite doesn't cover it.
- `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor credit
  (owner action; code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via `read_attachment`).
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase.
  Constraints: the AI SDK stack must stay on MATCHING majors — currently **`ai@6` + v3-spec
  providers** (`@ai-sdk/anthropic@3.x`, openai 3.x, openai-compatible 2.x), since v13.3. Also:
  zod mid-v4; **4** patch-package patches (the newest un-poisons transformers.js's session
  chain); ABI-pinned better-sqlite3/node-pty/keytar. Worklist = `npm outdated` (direct) +
  `npm audit` + own deprecated-API usage + CI action EOLs; leave pinned/transitive with a note.

---

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the
  existing `@atlarix review` GitHub bot: mention it, it picks up the task, works in a real Atlarix
  workspace, and posts the PR/result back (near-zero switching cost, big reach; how Devin /
  Copilot-in-Slack win). (b) A **shared, observable agent session** — a "war room" where several
  teammates watch one Atlarix run live, drop steering comments, approve actions, and hand off —
  tied to the Workforce tier. The chat shell is not the differentiator; the shared *agent* session
  is. Far-off; capture, don't build yet.

---

## 📦 Shipped — index

Full prose in [`docs/CHANGELOG.md`](./CHANGELOG.md). Listed here only for the trap each release
left behind, because those are the parts that cost time twice.

| Version | Shipped | Trap worth remembering |
| --- | --- | --- |
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it, not one that was ever loaded — two diagnoses were wrong before the (device × dtype) matrix settled it. And `postinstall`'s trailing `\|\| true` guards **patch-package**, absent from the pruned tree, not the Electron install; re-parenthesising it broke Windows packaging at tag time. |
| **v14.29.0** | automated Store submission, WSL Landlock confinement, sandbox path fixes | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads **422 green while keeping the OLD asset** — delete the draft before re-tagging. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads** — the inverted primitive, and unfixable per-path (no ACL for the device map or object namespace). `cargo check --target x86_64-pc-windows-msvc` works from macOS; `cargo build` on `cfg`-gated crates proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event — renderer listeners must be `(payload) =>`; 11 written `(_e, payload)` silently never fired. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows **drive-letter colon** is not a field separator (grep discarded every match); an absolute glob pattern must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine catches either. |
| **v14.25.0** | honest context accounting, skills on demand, one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
| **v14.24.0** | the clone dialog actually clones | `ext::` URLs are RCE through git; git stderr leaks the OAuth token unless redacted. Owner directive: the save folder is ALWAYS the user's explicit choice — no default, no memory between clones. |
| **v14.23.0** | providers off the hardcode; a plan gate that stops fighting | The unit vitest projects had no explicit `testTimeout` and inherited 5,000 ms, so suites failed differently depending on machine load. Now 30 s (`UNIT_TEST_TIMEOUT_MS`); `agent-evals` keeps 90 s. |
| **v14.22.0** | edits that don't corrupt files; a harness that tells the truth | **Symmetry rule:** whatever transform found the match must apply to the replacement. Absorb tool aliases in the registry, don't prompt against them. knip is report-only; a pipe masks exit status. |
