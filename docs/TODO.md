# Atlarix TODO

**Current Version:** v14.31.0 (2026-08-16) — a real Network tab, and nothing the browser sees can
block a turn any more.
**Last Updated:** 2026-08-16

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative → [`docs/CHANGELOG.md`](./CHANGELOG.md). Designed-but-unscheduled
> work → [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md). Both get a one-line pointer here and nothing
> more. Trimmed 2026-08-11 and again 2026-08-15; `git log -- docs/TODO.md` has every word.

---

## 🔨 In flight — landed, not yet released

Nothing. v14.31.0 shipped the Console + Network work, the session-restore hang, retry jitter,
delegation stagger, and the notification crash fix. What each left behind is in the Shipped index;
what is still owed from them is below, under the machine that can confirm it.

---

## 🚧 Needs the Windows machine

The one place several things can only be confirmed. Grouped so a single session clears them all.

### v14.31.0 — the notification crash (LINUX, not Windows)
- [ ] `SIGSEGV` in `electron::NotificationPresenter::RemoveNotification` — a Sentry report from
      Fedora 44, fixed by holding each `Notification` until `close`/`failed` instead of dropping the
      reference at `show()`. **The fix is reasoned, not observed**: it reproduces only on Linux, and
      only as a race against the notification daemon's own teardown.
- [ ] Confirm by leaving the app unfocused through several automation runs and turn-done
      notifications, letting each expire on its own rather than clicking it. Success is the absence
      of a crash and a clean Sentry week; failure would be another minidump on the same frame.

### v14.30.0 — on-device voice on the CPU path
- [ ] Install the release and dictate. **Success is the log**
      (`%APPDATA%\Atlarix\logs\main.log`): `loading onnx-community/whisper-small on … (dtype=q4)`,
      then `model ready on device=webgpu` **or** `device=wasm` — **either is a pass**, and `wasm` is
      the more valuable result because that is the path that was broken. Then `transcript(N chars)`.
- [ ] **Must NOT appear:** `MatMulNBits`, `Missing required scale`, `stopped downloading`.
- [ ] Download is ~285 MB (not ~800 MB); the mic is **clickable while it downloads**.
- [ ] Same on Linux, never tested, now on the same WebGPU-first path.

### Windows sandbox (Low IL) — from the v14.28.0 rebuild
- [ ] `run_command` must succeed with git under Low IL. **This is the whole point.**
- [ ] `--self-test` → **8 probes** including `sandbox`; confirm an **info**-level
      `Sandboxing run_command` line (it was `debug`, so only failure was ever visible).
- [ ] `CreateProcessAsUserW` succeeds unprivileged. `ERROR_PRIVILEGE_NOT_HELD (1314)` means the
      probe reports the sandbox unusable and commands run unconfined — then implement Codex's model.

### MSIX / Store build
- [ ] Run the spike (`docs/MSIX_RUNBOOK.md` §4). **Baseline on Squirrel FIRST** — a failure inside
      MSIX is otherwise unattributable.
- [x] **A Squirrel → Store reinstall keeps the user's data** — verified by hand 2026-08-12.
      `userData` does not diverge in the package container, so **no migration is needed** and it is
      safe to tell users to reinstall from the Store (the 2026-08 outreach email does). Checked
      manually, so the exact path string is still unrecorded — the one remaining piece.
- [ ] Manifest protocol declaration works (OAuth sign-in) and `atlarix://pro-return` completes a
      Lemon Squeezy purchase.

---

## 🧭 Designed — awaiting a session

Full reasoning in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md). One line each so this file stays a
queue, not a design doc.

- **QA sub-agents** — up to 3 declared *surfaces* (web/api/mobile/mcp/cli) that exercise the running
  app and report evidence-backed findings. Gets the requirement, **not the diff** — independence of
  judgment is the point. A scoped `http_request`, not the terminal. Load testing is an explicit
  non-goal. **Settled 2026-08-17:** coverage workers (QA, implementer) get an enumerated contract in
  the spawn payload and return one validated entry per item — no check-off tool, because self-report
  is unverifiable exactly on the weak models it would be added for.
- **Smaller upstream-review items** — native PDF parts, `run_command` memory/Job-Object
  containment, `llama-server` detection (for the true `n_ctx`, not the connection), per-model
  sampling defaults, chore-model routing, malformed tool-arg handling, a Windows path-validation
  matrix, nested-repo trust on mid-session clones, approval notifications, a session web-fetch cache.

---

## ⏳ Open / deferred

- **OWED from v14.31.0: the packaged-app pass on Console + Network.** Everything below the UI was
  verified — full suite, and an integration run of the real capture module against youtube.com in
  Electron 38 (43 rows, all identified; bodies 8/8 on demand; youtube → github grew the log 43 → 105
  instead of clearing it; clean detach and tab close). **The two panels themselves have only been
  reasoned about.** Reproduce the original report exactly: open YouTube, confirm the signed-out 401
  appears in Network and does **not** block the turn; navigate to GitHub and confirm a divider plus
  two distinct cards; expand a row and pull a body; confirm a page logging in a loop neither stalls
  the UI nor floods it; confirm the app window's own DevTools still opens.
- **The CSP does not reach the whisper worker.** `installContentSecurityPolicy()` (`main.ts:304`)
  is enforced on the `file://` document — verified — but a dedicated worker loaded from `file://`
  does **not** inherit it, and `eval()` runs freely inside. So A13/M-6 does not cover
  `whisper-worker`, and the `'wasm-unsafe-eval'` in the policy is not what lets ONNX compile. Low
  urgency (own bundled code, HF fetch only), but the function's comment claims coverage it lacks.
- **Configurable read-deny patterns, opencode-style** — user-declared only
  (`read: { "<pattern>": "ask" | "allow" | "deny" }`), no defaults; chosen over Codex's model
  because it keeps `lib/tools/glob.ts:221` intact — that line records the deliberate decision that
  *"in-workspace files (incl. .env) are enumerable"*. **The caveat dominates the estimate:** a
  deny-read is only real if `run_command` can't `cat` the file. macOS Seatbelt and Linux Landlock
  are both cheap; **Windows Low IL cannot** — MIC is `NO_WRITE_UP`, so reads up are allowed by
  design, and the AppContainer that *could* deny reads is exactly why it broke. Scope as tool-level
  everywhere + sandbox-level on macOS/Linux + a documented Windows gap.
- **Landlock `ABI::V5` (`IoctlDev`)** once there's a compatibility test for device ioctls.
- **`proxy-worker` self-test probe can't run from source:** `start_proxy_server.ts:30` resolves
  `__dirname/../../worker` — right when packaged, wrong under vitest. Covered meanwhile by
  `src/__tests__/proxy-passthrough.test.ts`.
- **Packaging registry (deliberately deferred).** `runNpmInstall` (`forge.config.ts`) spawns npm
  with no `--registry`, in `buildPath` outside the project, so a custom global registry wins and
  `packageAfterPrune` dies with `E401`. Until it lands, `npm run package` needs
  `npm_config_registry=https://registry.npmjs.org/`. Held pending the owner's account migration.
- **Sub-agent results still don't *continue* in the timeline** — STILL OPEN, deliberately not
  attempted. Results now RENDER properly; what remains is purely placement (they sit in round-panel
  cards behind the expand affordance rather than resolving inline). Direction: weave settled
  `subagent` items via `weaveIpcItemsIntoParts` (`WEAVABLE_KINDS` excludes `subagent_round`) and
  collapse the panel once all agents settle. **Why it keeps being skipped:** its entire value is
  visual placement, in the most reflow-sensitive code in the renderer — `AssistantMessageBody`'s
  sticky-agents / seam-offset / synthesized-round interaction, which already produced one "scratchy
  rendering" regression. Land it in a session that starts with the packaged app open.

### Checked and CORRECT as-is — do not "fix" these

From the 2026-08-05 hardcoding sweep. The test in every case is *what happens when the list is
incomplete*; the reasoning is in git.

- **`defaultWritablePaths`** (`lib/sandbox/wrap-command.ts`) — a *write* allowlist; incomplete fails
  CLOSED into the escalation flow. Probing `$HOME` dynamically would WIDEN the sandbox.
- **`DANGEROUS_PATTERNS`** / **`SYSTEM_SCOPE_PATTERNS`** — UX gates, not boundaries; the sandbox
  catches anything unlisted.
- **`DENIAL_PATTERNS`** — extracts a path from tool prose; a miss degrades into
  `sandbox-failure-context.ts`, not into silence.
- **Browser error capture** (`lib/browser/error-hook.ts`) — filters on the browser's own console
  `level` and HTTP status, never on curated strings. Already derived.
- **`file-permission-scope.ts`** — the v14.23.0 protected-path deletion has not crept back.
- **`models_dev.ts` / provider dispatch** — de-hardcoded in v14.23.0; only documented pins remain.
- **Browser `KEY_ALIASES` / `MODIFIER_TOKENS`** — a closed set from the DOM spec.

---

## 🔜 Blocked on the owner — NOT active work

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI (release-infra, no
  cert). OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in,
  reverted; the flow-in-progress gate stays).
- **Billing A/B:** confirm OpenRouter `usage.cost` includes the ~$0.005 search fee so the wallet
  debit = `ceil(cost × 1.4)`; else add a proxy surcharge in `atlarix-proxy/src/server.ts`.
- **DB shutdown-race stress-verification** on a packaged build (guard committed, not stress-tested).
- **Dependency deprecation triage** — its own release; roadmap, not queue. See below.

---

## 🔎 Recorded — not scheduled

- **The Dyad-era hosted-engine subsystem is orthogonal to the current architecture, and whether it
  is still a product is an OWNER decision.** `get_model_client.ts:170-221` branches to
  `createAtlarixEngine` at `https://engine.atlarix.dev/v1` whenever `settings.enableAtlarixPro` is
  set — still live user-facing UI at `ProviderSettingsPage.tsx:414`. Hanging off it:
  `llm_engine_provider.ts`, lazy edits, smart-files context, deep context, and the git-history half
  of `versioned_codebase_context.ts` (kept because its second loop does real work — reading paths
  named in past assistant turns back out of git at the commit they recorded). None of it relates to
  Core-as-prepaid-wallet-through-the-proxy. Not a coding-session call.
- **`selectedComponents` still flows renderer → IPC → `ChatStreamParams` and is read by nothing on
  the main side.** Same Dyad-era shape; unpicking it belongs with the decision above.

---

## 🔐 Security follow-ups (owner-triaged, from `docs/SECURITY_REVIEW_v14.8.12.md`)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF + pro-return
confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP description wrapping +
OAuth-URL validation, the **universal write-confining sandbox** (Windows since rebuilt on Low IL,
v14.28.0), and the **system-scope approval gate** (which also closed M1). **Deferred:**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (signing certs + `app-update.yml` for NsisUpdater; out-of-band signature for
  AppImage), not app code. Owner chose NOT to gate the public release on it; the Windows helper
  sign step is wired — set the cert secret to enable.
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS.
  `npm run check:sandbox` cross-target type-checks both and the helpers are gated on behaviour, but
  neither substitutes for running them on the real OS.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the denylist
  taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL allowlist
  permits a query param (current gate = flow-must-be-in-progress).
- Sandbox **read**-confinement (Windows blocker in the read-deny entry above), **egress** gating,
  and the remaining Mediums (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

---

## 📋 Carried / small

- **CLOSED — fork sub-agents. The arithmetic does not work; do not re-propose.** A cache read is
  ~0.1× base input, but the inherited prefix is re-sent on **every step** of the worker's loop, not
  just the first — so an 8-step fork pays ~8× the discount it was supposed to save, for context it
  never asked for. It only breaks even for a very short worker, which is the case where the parent
  should not have delegated at all. Separately, the cache hit requires sharing the parent's toolset,
  which hands the least-supervised worker the full write surface. The real problem it targeted —
  workers re-deriving what the parent knows — is answered by **pointers, not payloads**: prompt and
  tool-description work pushing the parent to hand over the `file:line` facts it already has. Full
  reasoning in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- **CLOSED — model-context secret redaction. Decided twice; do not re-propose.** Rejected in
  v14.12.0 (owner trusts the agent and the provider with credentials) and again **2026-08-17** on
  the reframed version. The reframe argued that because we hold the user's real secret *values*,
  exact-string redaction is zero-false-positive. That is true and still not sufficient: **no list
  caters for every form a secret takes**, and the tier-2 vendor-prefix set is exactly the kind of
  hardcoded list this project has repeatedly decided against — it would be wrong at the edges,
  need maintaining forever, and give the impression of a guarantee it cannot make. Display-side
  and telemetry-side redaction (Sentry `beforeSend`, git-stderr credential stripping) are a
  different concern and stay.
- **CONSIDER (evaluated → CLOSED): `browser-use`.** Python/Playwright (bad Electron fit), its own
  agent loop, and its one good idea (stable element refs) we already have via `browser_inspect`
  snapshot `ref`s. No capability gap.
- **CONSIDER (evaluated → REFERENCE ONLY): `h5i`** — a peer harness, not a library, and its leverage
  is Linux, which we already ship natively. Worth borrowing its `supervised` tier (egress
  allowlist), a capability we lack; see [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- **No test measures whether our own suite is sensitive** — no mutation testing, no eval where the
  fixture's suite is deliberately wrong, so "tests pass" is a claim about the suite, not the change.
  Two clean instances in v14.30.0; see [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor credit
  (owner action, code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via `read_attachment`).
- **Dependency deprecation triage (own session).** Scoped, not a blanket zero-warnings chase.
  Constraints: the AI SDK stack must stay on MATCHING majors — currently **`ai@6` + v3-spec
  providers** (`@ai-sdk/anthropic@3.x`, openai 3.x, openai-compatible 2.x) since v13.3. Also zod
  mid-v4; **4** patch-package patches (the newest un-poisons transformers.js's session chain);
  ABI-pinned better-sqlite3/node-pty/keytar. Worklist = `npm outdated` (direct) + `npm audit` + own
  deprecated-API usage + CI action EOLs; leave pinned/transitive with a note.

---

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the
  existing `@atlarix review` bot: mention it, it picks up the task, works in a real Atlarix
  workspace, posts the result back (near-zero switching cost; how Devin / Copilot-in-Slack win).
  (b) A **shared, observable agent session** — a war room where teammates watch one run live, drop
  steering comments, approve actions and hand off, tied to the Workforce tier. The chat shell is not
  the differentiator; the shared *agent* session is. Capture, don't build yet.

---

## 📦 Shipped — index

Full prose in [`docs/CHANGELOG.md`](./CHANGELOG.md); older versions live there only. Listed here for
the trap each release left behind, because those cost time twice.

| Version | Shipped | Trap worth remembering |
| --- | --- | --- |
| **v14.31.0** | Network tab; browser runtime gating removed; session-restore hang; notification crash | `Network.enable` **hangs forever** on a tab that has never navigated — attach resolves, the command never does, no error at all; prime `about:blank` first and time-bound every CDP command. A `Notification` you stop referencing after `show()` is collected while the OS is still displaying it, and the teardown races the daemon's — a native `SIGSEGV` no JS handler can see. A broadcast that early-returns on the empty case (`if (!s) return`) can never clear a loading flag, so **the failure case is exactly the case that gets no message**. |
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it, not one that was ever loaded — two diagnoses were wrong before the (device × dtype) matrix settled it. And `postinstall`'s trailing `\|\| true` guards **patch-package**, absent from the pruned tree, not the Electron install; re-parenthesising it broke Windows packaging at tag time. |
| **v14.29.0** | automated Store submission, WSL Landlock confinement, sandbox path fixes | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads **422 green while keeping the OLD asset** — delete the draft before re-tagging. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads** — the inverted primitive, unfixable per-path. `cargo check --target x86_64-pc-windows-msvc` works from macOS; `cargo build` on `cfg`-gated crates proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event — renderer listeners must be `(payload) =>`; 11 written `(_e, payload)` silently never fired. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows **drive-letter colon** is not a field separator (grep discarded every match); an absolute glob must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine catches either. |
| **v14.25.0** | honest context accounting, skills on demand, one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
