# Atlarix TODO

**Current Version:** v14.30.0 (2026-08-11) — on-device dictation works on Windows and Linux
(the CPU fallback had never built a session on any platform).
**Last Updated:** 2026-08-15

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative → [`docs/CHANGELOG.md`](./CHANGELOG.md). Designed-but-unscheduled
> work → [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md). Both get a one-line pointer here and nothing
> more. Trimmed 2026-08-11 and again 2026-08-15; `git log -- docs/TODO.md` has every word.

---

## 🔨 In flight — landed, not yet released

Needs a `docs/CHANGELOG.md` section at the next version bump. Both from the 2026-08-15 upstream
review.

- **Retry jitter** — `RECONNECT_DELAYS_MS` was fixed at 2s/5s/10s, so every client and all 5
  concurrent sub-agents retried in lockstep; on the Core path that stampede hits our own proxy. Now
  read through `jitteredDelay()`. A provider `Retry-After` still wins and jitter on it is additive
  only. **Trap noted at the constant:** `simple-stream-text.ts` sets the SDK's `maxRetries: 0` when
  tools are present, so ours is the ONLY retry — the two would multiply.
- **Browser runtime gating REMOVED — a deliberate behavioural change, not a bug fix.** Nothing the
  browser reports can block a turn any more: not a 4xx/5xx, not a console error, not a failed load,
  not a dead or blank renderer. **Why:** the harness cannot tell whose error it is. A frontend on
  `:5173` calling its own API on `:8080` is one app across two origins; a staging URL is the app
  under test; an embedded third-party script is not. Every rule we could write is wrong in one
  direction or the other, and a wrong block costs more accuracy than a missed one. The trigger was
  concrete — the agent opened YouTube to *read* it, Google's logged-out auth probe returned 401, and
  the gate nagged it to "fix" a third-party auth handshake. It correctly refused, then burned turns
  arguing with a gate that could not hear it.
  - `getPreviewRuntimeFeedback` / `getPreviewVisualFeedback` deleted; the gate calls in
    `run-agent-turn.ts` are gone. `blockingPreviewErrors` → **`runtimeFailuresSince`**, kept because
    `browser_test` still needs a verdict — but that is the agent *asking*, not the harness overruling.
    `BLOCKING_CONSOLE_LEVELS` → `FAILURE_CONSOLE_LEVELS`.
  - `console-capture-gate.test.ts` now asserts the **inverse** of what it asserted this morning, and
    guards against a gate being reintroduced by checking `run-agent-turn.ts` doesn't import either
    removed function.
  - **COST, accepted by the owner:** a Build turn can now end with the app white-screening and
    nothing stops it. What remains is the project's own checks (`tsc`, lint, tests, stop hooks).
    **The README's verified-edits wording needs re-reading against this before release.**
  - **The replacement is wired.** `buildRuntimeNotice()` emits a one-line pointer (counts + "read it
    with `browser_inspect`"), never the entries — a chatty page costs one line, not hundreds.
    Delivered **once per turn** on the productive-round path, which is reached only on
    `finish_reason:"tool-calls"` — a continuation the model already asked for. So it cannot extend a
    turn: if the model wants to stop, it stops and the notice is simply never sent. Transient
    steering, request-only, never persisted — the same shape the old gate-nudge used.
    - **Two traps it had to avoid, both documented in that file:** a per-round nudge previously
      re-elicited `read_file` on open-weight models until the turn exhausted (hence the once-per-turn
      flag), and folding a round's native messages into the request *only* silently dropped tool
      results from persisted history (hence transient-vs-fold being kept distinct).
  - **STILL OWED:** the user-side half — "Send to Atlarix" on a row/selection/all, an unread badge
    mirroring automations' `unreadCount`, and a setting for what triggers a notice (no hardcoded
    severity).
- **"Restoring your session…" could hang forever.** Reported by a user upgrading from v5–v8; not
  upgrade-specific once traced. `markStartupAuthResolved()` correctly runs in a `finally`, but the
  thing that TOLD the renderer — `broadcastSessionState()` — opens with `if (!s) return`, so **the
  failure case was exactly the case that got no message**. A renderer that asked before the restore
  settled then waited forever: no sign-in button, no error, no retry. Anyone launching **signed
  out** could hit it — `initialize()` only sets `session` when a user exists, and
  `restoreAuthSessionOnStartup` sleeps an unconditional 400ms first; a stale token widens that to
  seconds, which is why it fired every time for him and intermittently for everyone else.
  - Fixed with a dedicated **`auth:resolved`** broadcast from the same `finally`, always firing,
    carrying the user or `null`. A NEW channel deliberately — making `plan-changed` fire on a null
    session changes its meaning for other consumers. It rides the existing `auth-ipc-bridge`
    fan-out (ONE IPC listener for all ~22 `useAuth` mounts) and **replays to late subscribers**, so
    a lazily mounted route can't miss a once-only event.
  - Also: `checkSession`'s catch and missing-bridge path now set `authResolved` (a failed check is
    an answer — the renderer must not be stricter than the process it waits on); a 10s local
    fallback for paths no broadcast can reach; "Taking longer than usual" + a Sign in link at 5s.
  - **Verified in the packaged app 2026-08-15** — a signed-out cold start logs `No stored session on
    startup` and lands on a working sign-in screen, zero errors, `--self-test` 8/8.
  - **Reproduction trap:** turning Wi-Fi off does NOT reproduce it (DNS fails fast, so the restore
    settles fast). It needs a *black hole* — `/etc/hosts` → `192.0.2.1`, or Network Link Conditioner
    "100% Loss". And `SUPABASE_URL` can't be overridden at launch: `NEXT_PUBLIC_SUPABASE_URL` is
    inlined at build time via Vite `define`, so it wins the `||`.
- **Errors tab → Console (half of Console + Network).** The tab was a *failure feed*: every console
  message below warning was discarded at capture, so the agent could see that something broke but
  never confirm that something WORKED. Now every level is captured, console and network get
  separate ring buffers (500 / 200 — one shared 50-entry buffer would evict a recorded 500 within
  seconds of a chatty page), and the tab shows the page console as a chronological stream with
  level filter chips beside the file-grouped build errors. **Default filter is Errors + Warnings —
  identical to the old view.** `browser_inspect(mode:"console")` gained a `level` filter and no
  longer returns network failures (it was never a console view).
  - **Then the gate was removed entirely** — see the Console+Network entry below. Nothing a browser
    tab reports can end a turn any more.
  - **Latent bug fixed on the way:** `normalizeConsoleLevel` — the old numeric mapping read
    Electron's `console-message` integers as `2 = error, 3 = warning`, the inverse of the documented
    "verbose, info, warning, error" order. Dead on Electron 38 (always the string branch), but on
    that path every warning would have blocked a turn and every real error sailed through.
  - **Deleted the Dyad-era CDP path** (`console_debugger.ts` + its two IPC channels). It attached a
    debugger to the APP window, which since v14.15.0 cannot see the user's app at all — that runs in
    a Browser tab, a separate `WebContentsView` and so a separate CDP target. Worse than dead: its
    filter only recognised the **dev-server port**, so in a packaged build Atlarix's own renderer
    errors were forwarded to users as errors in their app. It also held `webContents.debugger`,
    blocking the user from opening devtools on the app window.
  - **OWED: the packaged-app pass.** Confirm all levels appear with working filters, the default
    view matches the old one, a page logging in a loop neither stalls the UI nor blocks a turn, and
    devtools now opens on the app window.
- **Runtime gating removed; network capture built.** Nothing a browser tab reports blocks a turn any
  more — the harness cannot tell whose error it is (a frontend on `:5173` calling its own API on
  `:8080` is one app across two origins), and a wrong block costs accuracy. The model gets ONE
  `systemReminder` pointer per turn naming counts and the read tool, never a dump.
  - **Capture has two tiers.** CDP (`webContents.debugger` + `Network.enable`) on browser tabs —
    real timing, transfer size, bodies on demand. On attach failure / detach / `ATLARIX_BROWSER_CDP=0`
    a tab is marked degraded and records through `webRequest` plus a page-injected `fetch`/XHR
    wrapper for bodies. Storage is **per tab** (`network-entry.ts`, cap 500).
  - **Traps encoded, all measured on Electron 38.2.2:** `Network.enable` **hangs forever** on a tab
    that has never navigated — attach resolves, the command never does, no error — so `createTab`
    primes `about:blank` first and every CDP command is timeout-wrapped. `closeTab` detaches
    **before** `webContents.close()`. Response bodies are frequently evicted (4/25 and 9/25 on a
    heavy page), so "no longer buffered" is its own message, not an empty body.
  - **`onBeforeRequest` is installed lazily**, on the first tab that degrades. It is the only
    BLOCKING webRequest hook; always-on would charge every request in every tab a main-process round
    trip for a path most sessions never take.
  - **Still owed:** the UI (see Designed), user-side "Send to Atlarix" routing, the unread badge, a
    setting for what triggers a notice, per-tab cards + navigation separators, and the packaged-app
    pass.
- **Delegation stagger** — `acquireDelegationSlot()` spaces same-turn siblings by
  `ATLARIX_DELEGATION_STAGGER_MS` (default 750ms, 0 disables), so the first writes the shared cache
  prefix and the rest read it. **Deliberately NOT gated on `resolveCacheMarkerPlacement`** — that
  only reports whether we place EXPLICIT markers (Claude family), while DeepSeek/Z.AI/OpenAI cache
  prefixes automatically, and those are exactly the Core providers where the saving lands.

---

## 🚧 Needs the Windows machine

The one place several things can only be confirmed. Grouped so a single session clears them all.

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
  non-goal.
- **Network tab — UI only; capture is built.** Both tiers now record (see In flight). What is left
  is the renderer: rows (method/status/type/duration/size), expand for headers and bodies,
  per-tab cards, and widening `browser_inspect(mode:"network")` past failures-only with a `tab_id`
  argument on both modes. Design in `docs/DESIGN_NOTES.md`.
- **Fork sub-agents** — a worker inheriting the parent's history so it reads the cache prefix
  instead of writing one. Pulled from the 2026-08-15 batch on discovering the prefix is
  `tools → system → messages`: a fork must share the parent's **toolset and system header** or the
  cache buys nothing, making it a distinct worker kind and read-only a *policy* question at the
  tool-execution funnel, not a toolset one.
- **Model-context secret redaction** — no longer blocked on read-confinement. We already hold the
  user's real secrets, so exact-value redaction is zero-false-positive with no ruleset; ~20
  vendor prefixes are tier 2; skip the entropy tier.
- **Smaller upstream-review items** — native PDF parts, `run_command` memory/Job-Object
  containment, `llama-server` detection (for the true `n_ctx`, not the connection), per-model
  sampling defaults, chore-model routing, malformed tool-arg handling, a Windows path-validation
  matrix, nested-repo trust on mid-session clones, approval notifications, a session web-fetch cache.

---

## ⏳ Open / deferred

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
- **Model-context secret redaction** — unblocked and reframed; see
  [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- Sandbox **read**-confinement (Windows blocker in the read-deny entry above), **egress** gating,
  and the remaining Mediums (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

---

## 📋 Carried / small

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
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it, not one that was ever loaded — two diagnoses were wrong before the (device × dtype) matrix settled it. And `postinstall`'s trailing `\|\| true` guards **patch-package**, absent from the pruned tree, not the Electron install; re-parenthesising it broke Windows packaging at tag time. |
| **v14.29.0** | automated Store submission, WSL Landlock confinement, sandbox path fixes | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads **422 green while keeping the OLD asset** — delete the draft before re-tagging. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads** — the inverted primitive, unfixable per-path. `cargo check --target x86_64-pc-windows-msvc` works from macOS; `cargo build` on `cfg`-gated crates proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event — renderer listeners must be `(payload) =>`; 11 written `(_e, payload)` silently never fired. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows **drive-letter colon** is not a field separator (grep discarded every match); an absolute glob must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine catches either. |
| **v14.25.0** | honest context accounting, skills on demand, one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
