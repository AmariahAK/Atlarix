# Atlarix TODO

**Current version:** v14.35.0 — Electron 43, Touch ID passkeys, browser-backed web search, the
spec-line majors, 54 → 28 advisories, the Dyad-era removal (~30,500 lines), plan switcher +
plan-by-title, automations returning their id, the ban system, the whisper-worker CSP, and four
plan-tracking fixes.
**Last updated:** 2026-08-20

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative → [`CHANGELOG.md`](./CHANGELOG.md). Design prose →
> [`DESIGN_NOTES.md`](./DESIGN_NOTES.md). Operational SQL and steps → the runbooks
> ([`BAN_RUNBOOK.md`](./BAN_RUNBOOK.md), [`MSIX_RUNBOOK.md`](./MSIX_RUNBOOK.md)).
>
> **Refined 2026-08-20.** This file had reached 1,135 lines, 46% of it v14.35.0 release narrative
> that belongs in the changelog. Every open item and every trap survived the cut, compressed to its
> operative sentence; `git log -- docs/TODO.md` has every word of the long form. The failure mode
> being corrected is a queue that reads three times its real size, so genuinely open work hides
> inside finished work. Previously trimmed 2026-08-11 and 2026-08-15.

---

## ✅ Verification owed — code done, no code expected

These are trips and clicks, not tasks. Each fix is already shipped.

- [ ] **Console + Network packaged pass** — owed since v14.31.0. Needs a workspace open, a
      hand-driven browser tab and a live turn. Reproduce the original report: YouTube's signed-out
      401 appears in Network and does **not** block the turn; navigating to GitHub gives a divider
      plus two distinct cards; expand a row and pull a body; a page logging in a loop neither stalls
      nor floods the UI; the app window's own DevTools still opens.
- [ ] **Anthropic extended thinking — BELIEVED fixed, not OBSERVED fixed.** The capability branch,
      the SDK-shaped `budgetTokens` and the temperature omission are covered by 12 tests (verified
      sensitive), but there is no Anthropic key here and the failure mode is a provider-side **400**,
      so the request has never been sent. **The check:** one reasoning prompt on a Claude model with
      a real BYOK key — no 400, and thinking parts stream. If it 400s, suspect temperature:
      Anthropic accepts only `1` with thinking on and `getTemperature` defaults to `0`, which is
      exactly why `shouldOmitTemperature` exists.
- [ ] **The authenticated ban deny-path.** As a signed-in test user (**not** service role):
      `update public.users set banned_at = null where id = auth.uid();` must error with
      `users.banned_at is managed by Atlarix`. A service-role probe cannot stand in — `service_role`
      is precisely the branch that bypasses the guard. Everything else about bans is verified live
      (banned → gate appeared on a live session in ~1s → lifted → `pro/pro`, audit row closed).
- [ ] **Whisper-worker dictation under the new CSP.** The worker only spawns when a composer mounts
      with the local provider, so it needs a workspace open. Confirm dictation still transcribes and
      the log carries `[csp] APPLY resourceType=script … whisper-worker`. If ONNX fails to compile,
      revert to docstring-only — a blocked worker that also blocks WASM is worse than the gap.
- [ ] **`read_url` through a real turn** against a JS-rendered SPA and a bot-walled page. The
      mechanism is measured (excalidraw 69 → 722 chars, g2.com 0 → 251, five parallel fetches 624ms);
      what is untested is the path through the packaged app's own tool.
- [ ] **A real passkey on a CI-SIGNED build.** Not doable locally by design: `postPackage` ad-hoc
      re-signs darwin builds, stripping entitlements and hardened runtime, so `configureWebAuthn`
      fails locally. Read `main.log` for `[webauthn] Touch ID configured` before blaming the site — a
      failure looks identical to the old bug.
- [ ] **CI must resolve the win32 + linux TypeScript 7 platform binaries.** Only darwin-arm64 is
      proven.
- [ ] **Confirm `[prompt-cache]` still shows a large `read=` on later turns in a mode.** A `write=`
      that jumps every turn would mean the per-mode tool-description tiering is invalidating the
      cached prefix.

## 🚧 Needs the Windows machine — one trip clears all of it

**Every fix below is ALREADY SHIPPED.** This is a verification checklist. Counting it as a backlog is
what made this queue read three times its real size.

- [ ] **Electron 43** — `self-test:packaged` reporting **9 probes** including the new `sqlite` one
      (the only genuinely ABI-pinned module, and the one nothing used to cover), and a passkey site
      showing the notice instead of hanging. The upgrade does **not** revalidate the sandbox helpers —
      standalone Rust binaries, no Node ABI coupling — but they need this machine anyway, below.
- [ ] **Passkey notice ACCURACY**, which is the real check now: it must **not** appear for a request
      that explicitly asks for a roaming authenticator, because a USB key or a phone over hybrid/QR
      should simply work. Verify one actually does. Only the PLATFORM authenticator is macOS-only.
- [ ] **Windows sandbox (Low IL, v14.28.0)** — `run_command` must succeed with git under Low IL;
      that is the whole point. Confirm an **info**-level `Sandboxing run_command` line (it was
      `debug`, so only failure was ever visible). `CreateProcessAsUserW` must succeed unprivileged —
      `ERROR_PRIVILEGE_NOT_HELD (1314)` means commands run unconfined, and then implement Codex's model.
- [ ] **Process-tree kill (v14.32.0)** — `taskkill /pid <pid> /T /F`. Reasoned from documented
      behaviour, not observed; the real-process test is skipped on Windows. Start a dev server through
      `run_command`, cancel it, confirm no node process survives and the port is free.
- [ ] **On-device voice (v14.30.0)** — dictate and read `%APPDATA%\Atlarix\logs\main.log`:
      `dtype=q4`, then `device=webgpu` **or** `device=wasm` — either is a pass, and `wasm` is the
      valuable one because that is the path that was broken. Must NOT appear: `MatMulNBits`,
      `Missing required scale`, `stopped downloading`. ~285 MB, mic clickable while downloading.
- [ ] **MSIX §4 behaviour check** (`MSIX_RUNBOOK.md`) — **baseline on Squirrel FIRST**, or a failure
      inside MSIX is unattributable. Plus: the manifest protocol declaration works for OAuth, and
      `atlarix://pro-return` completes a Lemon Squeezy purchase. Not to be confused with the packaging
      spike, which ran 2026-08-07. A Squirrel → Store reinstall **keeps user data** (verified by hand
      2026-08-12, so no migration is needed); the exact `userData` path string is the one piece still
      unrecorded.
- [ ] **Linux, not Windows: the notification SIGSEGV** in
      `electron::NotificationPresenter::RemoveNotification` (Fedora 44 Sentry report). Fix is
      reasoned, not observed. Leave the app unfocused through several automation runs and let
      notifications expire rather than clicking them; success is a clean Sentry week.
- [ ] Linux voice, never tested, now on the same WebGPU-first path.

## ⚠️ Known and NOT fixed — deliberately, with reasons

- **`withLock` serialises TWO callers, not N.** `src/ipc/utils/lock_utils.ts` awaits only the one
  lock it observed, so with three contenders B and C both wake on A's release and **both acquire** —
  C's `locks.set` overwrites B's. Correct for two callers, silently not a mutex beyond that. Found
  while fixing the plan lost-update race, which is why plan writes use their own FIFO chain
  (`withPlanArtifactLock`). Its callers are app-lifecycle paths; whether they ever see three
  concurrent callers is the open question. Changing shared locking semantics deserves its own pass.
- **A `DatabaseClosingError` escapes as an unhandled rejection.** Three boot tasks catch it and log
  "non-fatal"; one leaves a floating promise, so it reaches Sentry as `handled = no` and pages the
  owner. The guard is right; one boot task needs a `.catch`. Any user who quits during startup can
  hit it.
- **Local packaged builds report `environment=production` to Sentry**, so a developer machine fires
  production alerts. `app.isPackaged` is true for a local ad-hoc build, so it is the wrong
  discriminator. Gate the DSN on a CI-injected marker or the signing identity instead.
- **`useAuth` is an UNSHARED hook with ~22 consumers**, each running its own `checkSession()` —
  still the cause of repeated "Enforcing workspace limit" logs. Guard in the IPC handler, never in
  the hook. **The sign-out half is now scoped:** `SubscriptionManager.signOut()` does not broadcast
  `auth:resolved`, so only the instance that initiated a sign-out updates and a second window keeps
  a stale session. `broadcastAuthResolved()` already has no null-session guard (deliberately — that
  guard *was* the bug), so the fix is one call plus making `handleAuthResolved` clear `user`/`status`
  on a null user instead of early-returning. Do it with the rest of the unshared-hook work.
- **vite 8 warns that `configLoader: 'native'` will become the default** — `vitest.config.ts` uses
  ESM syntax while loaded as CommonJS. Harmless today, fatal when the default flips. The fix (`.mjs`
  or `"type": "module"`) changes how every config in the repo loads, so it wants its own change.
- **`ai@7`'s `instructions` placement is the aligned end state, not done.** `role:"system"` inside
  `messages` is re-permitted with `allowSystemInMessages: true` so the v10.1 prompt-cache layout
  stays byte-identical and measurable. Moving it into `instructions` (which accepts
  `Array<SystemModelMessage>`, so breakpoints could survive) needs its own commit and its own
  `[prompt-cache] read=` measurement.
- **`drizzle-kit` stays at 0.30.6** while `drizzle-orm` is 0.45.2. **Bump it before the next schema
  change**, or `db:generate` runs against a mismatched pair.
- **Accepted advisories, with reasons rather than a shrug.**
  `@huggingface/transformers` → `onnxruntime-node` → `adm-zip` → `sharp` has no fix and is the
  deliberately-pinned voice stack. `shepherd.js` → `deepmerge-ts` (stack exhaustion on recursive
  merges) needs a major; the call site was checked rather than assumed — tour options are static
  literals in `TourManager.tsx`, so no attacker- or model-controlled object reaches the merge.

## 🔜 Blocked on the owner — not active work

- **Windows code-signing cert** — C6 auto-update signing + native-sandbox CI. Release infra, no cert.
  The Windows helper sign step is wired; set the secret to enable.
- **Rename the macOS bundle identifier — its own release, NEVER a rider.** It ships as
  `com.electron.atlarix`, @electron/packager's default (`packagerConfig` never set `appBundleId`),
  confirmed against a packaged `Info.plist`. **The risk:** macOS ties `safeStorage`'s keychain ACL to
  the app's designated requirement, which includes the bundle id — so a rename can leave every user's
  stored provider keys and Supabase session undecryptable, which is exactly the failure v14.27.0 was
  about. It also orphans every registered passkey (v14.35.0 baked the id into a signed
  `keychain-access-groups` entitlement), resets TCC folder grants, and orphans the Launch Services
  `atlarix://` registration. **Not at risk:** `~/Library/Application Support/Atlarix` is keyed on the
  app NAME, so chats and workspaces survive. Needs a `safeStorage` re-encryption migration and an
  upgrade-in-place test on a **signed** build. Cost of waiting is one round of passkey re-registration.
- **Two removable dependencies** — `@types/node-cron` (node-cron@4 ships its own types, so this is a
  dead v3 stub) and `ignore` (nothing imports it; `isomorphic-git` carries its own v5 in a separate
  tree, so dropping our v7 root cannot lower it; added in the fork era, `e900b590`). **`axios`,
  `bluebird` and `@mixmark-io/domino` are NOT removable** — see the packaging trap below.
- **Atlarix GitHub account** for contributor credit (owner action; code done).
- OAuth `state` nonce / PKCE stays **not doing** — attempted v14.12.0, broke sign-in, reverted. The
  flow-in-progress gate stays. Revisiting needs confirmation that the Supabase redirect-URL
  allowlist permits a query param.

## 🧭 Designed — awaiting a session

- **QA sub-agents, remaining half.** Shipped as a role. Still owed: **measure contract drift** —
  script a weak model over a multi-item coverage contract in `tests/agent-evals` and count dropped
  items. That number, not reasoning, decides whether a validated structured return is ever built.
  Recorded consequence of the no-gate decision: `browser_interact` has **no approval path in any
  mode**, so `DESIGN_NOTES`'s "destructive interactions go through the existing approval path"
  describes something that does not exist — and this is the first feature whose actions leave the
  machine, while our containment story is write-confinement, which says nothing about egress.
- **Run the session-load diagnostic** — `ATLARIX_DIAG_SESSION_LOAD=1` (main) +
  `localStorage["atlarix:diag:session-load"]="1"` (renderer), open the 1.43M-token session, record
  the four numbers. Ruled out: summarisation (zero compaction events in 13h of log) and tiktoken
  (memoised + delta-cached). Prime suspect `workspace_session_handlers.ts:751` —
  `parseDisplaySnapshot` per row on the main thread over a synchronous select with
  `SESSION_LOAD_MESSAGE_LIMIT = 100_000`. **A loading screen alone cannot fix it**: the overlay
  exists and cannot paint because nothing yields.
- **Configurable read-deny patterns, opencode-style** — user-declared only, no defaults; chosen over
  Codex's model because it keeps `lib/tools/glob.ts:221` intact (the deliberate decision that
  in-workspace files, `.env` included, are enumerable). **The caveat dominates the estimate:** a
  deny-read is only real if `run_command` cannot `cat` the file. macOS Seatbelt and Linux Landlock
  are cheap; **Windows Low IL cannot** — MIC is `NO_WRITE_UP`, so reads up are allowed by design, and
  the AppContainer that *could* deny reads is exactly why it broke. Scope as tool-level everywhere +
  sandbox-level on macOS/Linux + a documented Windows gap.
- **Sub-agent results still don't *continue* in the timeline.** They render correctly; what remains
  is placement (round-panel cards behind an expand affordance rather than resolving inline).
  Direction: weave settled `subagent` items via `weaveIpcItemsIntoParts`, collapse the panel once all
  agents settle. **Why it keeps being skipped:** its entire value is visual placement, in the most
  reflow-sensitive code in the renderer — `AssistantMessageBody`'s sticky-agents / seam-offset /
  synthesized-round interaction, which already produced one "scratchy rendering" regression. Land it
  in a session that starts with the packaged app open.
- **`run_command` memory/CPU containment** (cgroups / Job Objects) — the orphan half is done; this is
  the runaway-build half, and there is no observed failure yet.
- **`llama-server` `/props`** for the true `n_ctx` and chat template. Reachable today as a custom
  OpenAI-compatible endpoint, just falling back to heuristics. One provider, not a systemic bug.
- **Nested-repo trust on mid-session clones** — does a repo cloned mid-session re-trigger
  authority-file approval? Prompt-injection weight only: hooks were deleted and no `.atlarix` file is
  shell-executed any more.
- **Packaging registry (deliberately deferred).** `runNpmInstall` (`forge.config.ts`) spawns npm with
  no `--registry`, in `buildPath` outside the project, so a custom global registry wins and
  `packageAfterPrune` dies with `E401`. Until it lands, `npm run package` needs
  `npm_config_registry=https://registry.npmjs.org/`. Held pending the owner's account migration.
- **Chore-model routing stays OPT-IN.** `lib/summarization_model.ts` already offers `"same"`
  (default) or `"custom"`, and titles + compaction both route through it. Defaulting Core users to
  Core 1 would silently change what they are paying for.
- **No test measures whether our own suite is sensitive** — no mutation testing, no eval where the
  fixture's suite is deliberately wrong, so "tests pass" is a claim about the suite, not the change.
  Two clean instances in v14.30.0; see `DESIGN_NOTES.md`.
- **User-message multimodal parts for HISTORICAL turns** — current and edited turns embed since
  v14.8.11; history round-trips via `read_attachment`.
- **A future e2e suite must be wired into CI on day one.** Never being in CI is why the last one
  rotted unnoticed since v14.15.0 until 88% of its selectors were dead. Write it fresh against the
  workspace UI; see `DESIGN_NOTES.md` for why it was retired rather than repaired.

## 🔐 Security follow-ups — owner-triaged, deferred

The v14.8.12 review document was deleted once acted on (`b48002a6`). Fixed by v14.8.13: compound
danger gate, exfil taxonomy, deep-link auth-CSRF, MCP consent gate, `.atlarix` authority-file
approval, MCP description wrapping + OAuth-URL validation, the universal write-confining sandbox
(Windows since rebuilt on Low IL), and the system-scope approval gate (which also closed M1).
**Deferred:**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but release
  infra (signing certs + `app-update.yml` for NsisUpdater; out-of-band signature for AppImage), not
  app code. The owner chose not to gate the public release on it.
- **Native sandbox validation in CI.** The Windows/Linux helpers cannot compile on macOS.
  `npm run check:sandbox` cross-target type-checks both and the helpers are gated on behaviour, but
  neither substitutes for running them on the real OS.
- **Unattended read-only allowlist-flip** (a positive allowlist for automation runs) — the denylist
  taxonomy is done; the flip needs per-automation design to not break legitimate builds and tests.
- Sandbox **read**-confinement (Windows blocker above), **egress** gating, and the remaining Mediums:
  env-var key inheritance, secret-basename list, cross-workspace file scope, plaintext-keychain
  fallback.

## 💤 CLOSED — do not re-propose

- **Fork sub-agents. The arithmetic does not work.** A cache read is ~0.1× base input, but the
  inherited prefix is re-sent on **every step** of the worker's loop — an 8-step fork pays ~8× the
  discount it was meant to save, for context it never asked for. It only breaks even for a worker so
  short the parent should not have delegated. The cache hit also requires sharing the parent's
  toolset, handing the least-supervised worker the full write surface. The real problem — workers
  re-deriving what the parent knows — is answered by **pointers, not payloads**.
- **Model-context secret redaction. Decided twice** (v14.12.0, then again 2026-08-17 on the reframed
  version). The reframe was right that exact-string redaction of known values is zero-false-positive,
  and still not sufficient: **no list caters for every form a secret takes**, and the vendor-prefix
  tier is exactly the hardcoded-list pattern this project has repeatedly rejected — wrong at the
  edges, maintained forever, and implying a guarantee it cannot make. Display-side and telemetry-side
  redaction (Sentry `beforeSend`, git-stderr credential stripping) are a different concern and stay.
- **`browser-use`** — Python/Playwright (bad Electron fit), its own agent loop, and its one good idea
  (stable element refs) we already have via `browser_inspect` snapshot `ref`s. No capability gap.
- **`h5i` — reference only.** A peer harness, not a library, and its leverage is Linux, which we ship
  natively. Worth borrowing its `supervised` tier (egress allowlist), a capability we lack.
- **Dropped 2026-08-19:** the `.gitignore`-render profiler (six releases old, no observed problem);
  the `proxy-worker`-from-source self-test gap (a known limitation with a stated substitute,
  `proxy-passthrough.test.ts`, not a task); per-model sampling defaults (the `getTemperature` hook
  exists, but populating it needs a model we can show is hurt by `temperature: 0`); and the Windows
  path-validation matrix (scar tissue, no exploitable path, and it admitted it "may find nothing").
  Recover from git if evidence appears.

---

## 🧪 A test whose fixture is not in the repo — caught by CI 2026-08-20

`plan-row-select-columns-exist.test.ts` read `supabase/audit/prod_schema.sql`, which is **gitignored**
(`.gitignore:14`). So it passed on the author's machine and could only ever fail in CI — which it did,
on the release run, with `ENOENT`. **A test whose fixture is not tracked is not a test**, and nothing
local can tell you: `npm test` is green either way.

It now replays `public.users` from the **migrations**, which are committed and are the source of truth
anyway — the same conclusion the ban migration reached the hard way the same day, since that snapshot
is also *stale* (it predates the pricing-reframe teardown).

**Say the weakening out loud:** the original bug was a column that existed in a migration but was not
DEPLOYED, and a migration replay cannot see that. This now catches a typo, a rename, and a column no
migration creates — not an undeployed one. That case is held by the runbook discipline of deploying
first and by the `isUserBanned` pattern of querying a new column in its own request that tolerates
absence. Getting the deployed-schema check back needs a real database, not a file.

Cheap standing check: for every repo-relative path a test reads, `git ls-files --error-unmatch` it.

## 🪤 Traps worth not rediscovering

Grouped by where they bite. Each is the one sentence that would have saved the time; the long form is
in `git log -- docs/TODO.md` and `CHANGELOG.md`.

### Packaging, signing and native modules

- **`configureWebAuthn` before `whenReady` = SIGTRAP, exit 133** — `EXC_BREAKPOINT`, no exception, no
  log, nothing a `try/catch` sees. Electron's "call it early" means early *within* the ready phase.
- **`keychain-access-groups` on a nested binary = SIGKILL, exit 137** — while `codesign -v` calls it
  "valid on disk" and says it satisfies its Designated Requirement. Two plists: the group goes on the
  **top-level bundle only**, selected by `!filePath.includes(".app/")` (osx-sign's own test).
  `endsWith(".app")` is wrong — a helper bundle ends with `.app` too.
- **A local package is ad-hoc signed, so passkeys can NEVER work locally.** `postPackage` re-signs
  with `--force --deep --sign -` (because `packageAfterPrune` strips files after packager signs), so
  the bundle ends up `flags=0x2(adhoc)` with no entitlements and no hardened runtime. Not a bug.
- **`better-sqlite3` is the ONLY ABI-pinned native module.** `node-pty` is N-API (`Napi::` symbols in
  the prebuilt `pty.node`), and `keytar` is not a dependency at all. It needs **12.11.1** — 12.4.1
  does not compile against V8 15 (`External::New` gained a required tag, `This()` was removed).
- **Rebuilding in place breaks the test suite.** `@electron/rebuild` writes ABI 148 into
  `node_modules` and vitest runs under system Node; `npm rebuild better-sqlite3` restores it. CI never
  sees this because forge rebuilds the PACKAGED tree. (The `@electron/rebuild` CLI is also broken on
  Node 25 — irrelevant to CI, which calls the API, but it will waste ten minutes.)
- **Do not touch `postinstall`** — the trailing `|| true` guards **patch-package** (absent from the
  pruned tree), not the Electron install. Re-parenthesising it broke Windows packaging at tag time.
- **`node-abi` must know your Electron major** — 3.77.0 throws on 41/42/43; 3.94.0 is fine and still
  inside `@electron/rebuild`'s range, so no major bump is needed.
- **vite 8 compiles `import.meta.url` to `{}.url`** — undefined in a CJS build. `node-cron` was the
  only bundled package not guarding it, and the packaged gate caught a launch crash that tests, three
  type projects and lint all missed. It also FORKS a sibling located via `import.meta.url`, which
  cannot work inside an asar, so that path was already broken quietly.
- **A runtime dep that Rollup leaves as a bare `require()` MUST be declared in `package.json`** even
  though nothing imports it — that entry is what survives `packageAfterPrune`'s slimming
  (`keepRoots ∩ fullDeps`). `axios`, `bluebird` and `@mixmark-io/domino` are in `mainRollupExternals`
  for this reason; removing them ships a boot crash. **Check `mainRollupExternals` before believing
  knip.** `axios`'s direct range also drags `posthog-node`'s copy up to the SSRF-patched 1.19.0.
- **`electron-log` must stay BUNDLED** — externalising it initialises it twice and re-registers its
  `__ELECTRON_LOG__` IPC handler, crashing main at boot.
- **`--self-test` never reaches `whenReady`**, so it can no longer catch a `configureWebAuthn`
  regression. That needs a real launch.
- **E42 moved macOS notifications to `UNNotification`, which requires code signing to display** — an
  unsigned `npm start` silently shows none. Do not re-diagnose that as a regression. E43 dialogs also
  default `defaultPath` to Downloads; we set none anywhere, so that is the OS default changing.
- **`overrides` with exact pins fail the install loudly (`EOVERRIDE`), which is the lucky outcome** —
  a RANGE there would have silently held vitest at 3 and the upgrade would have "succeeded" while
  changing nothing. `vitest` + `@vitest/ui` stay EXACT: their peer link is an exact version.

### Release and CI

- **Verify the artefact users reach, not the one you just wrote.** `/releases/latest` is picked by
  `created_at`, and `atlarix-releases` has ONE commit — every release ties, and the tie never breaks
  forward. Needs `make_latest` plus a read-back of `/releases/latest` itself.
- **`curl -sS` exits 0 on an HTTP error.** A 503 mid-publish shipped a release as a DRAFT with all 12
  assets attached and every job green. Retry, then read the release back.
- **A 4–10 second failure with no retrievable log is a BILLING problem**, and the cause is only in
  the run **annotations**: *"The job was not started because an Actions budget is preventing further
  use."* Workaround is flipping the repo private → public for the release window (Actions is free on
  public) — ask first, and remember clones made during the window persist.
- **A hung job writes NO log** — `build-linux` sat 79 minutes on `apt-get` (11s the release before).
  Watch the **step's** `started_at`, not the run's. `cancel` + `rerun --failed` is lossless:
  successful jobs keep their outputs and uploaded assets are untouched.
- **Duplicate asset uploads 422 *green* while keeping the OLD asset** — delete the draft before
  re-tagging.
- **Verify `extract-changelog.sh` matches your heading BEFORE tagging.** The workflow passes
  `${TAG#v}`, so the `v` is stripped; the body must exceed 700 bytes or it is the bare download list.
- **Actions storage is a separate billing trap** and looks like nothing — no dead workflow, just an
  email. Cause was nine `atlarix-msix-x64` artifacts at 163–326 MB and 14-day retention (2.2 GB), for
  an artifact nothing downloads because Store submission is automated. Upload is now conditional on
  `workflow_dispatch` or a failed submit, retention 2 days. Diagnostic:
  `gh api "repos/AmariahAK/Atlarix/actions/artifacts?per_page=100" --jq '.artifacts[] | select(.expired==false) | "\((.size_in_bytes/1048576)|floor) MB  \(.name)"' | sort -rn`
- **`latest-mac.yml` is arm64-only by design.** CI sets `ATLARIX_CORE_MODEL_*` as real secrets.
- **A step that reads as success while the thing did not happen** is the recurring class here — three
  instances in one day. Read the result back, always.

### Migrations and Postgres

- **The source of truth for a `CREATE OR REPLACE` body is the newest MIGRATION that defines it** —
  never an audit snapshot, a docstring, or an older migration. `supabase/audit/prod_schema.sql` is
  **stale**: it predates the pricing-reframe teardown, which dropped `team_members`, `teams`,
  `users.team_id` and `users.has_db_studio_legacy`.
- **plpgsql resolves record fields at RUNTIME, not at definition time.** A body referencing a dropped
  column applies cleanly, the migration reports success, and then the first client `UPDATE` raises
  `record "new" has no field …`. The ban migration nearly shipped exactly that, which would have
  broken every authenticated write to `public.users`.
- **A verification fixture more generous than production verifies nothing.**
  `verify-ban-guard.mjs` invented `team_id`, `has_db_studio_legacy` and a `team_members` table, so it
  passed a body that could not run. Its column list now mirrors the live table.
- **Postgres `CREATE FUNCTION` grants EXECUTE to PUBLIC** — REVOKE for service-only DEFINER RPCs.
- **`created_at` defaults to `unixepoch()` — whole SECONDS.** Ties are undefined, so message order
  needs a **`rowid`** tiebreak; `id` is a random UUID, deterministic but WRONG. Worse, the DELETE
  paths sliced on that order, so a tie could delete the wrong message.
- Hand-write SQL + the journal entry + `db:bundle-sql` — the generator is not the source of truth.

### The harness

- **A decision that is GLOBAL cannot be made from per-window state** — and its mirror, a per-window
  decision made from global settings, put a Build turn in a read-only sandbox (`cannot lock ref
  'HEAD'`) across five sites, triggered by an EFFECT on window open with no click. Concatenate
  `main.old.log` + `main.log` when reading either. A runaway also ACCELERATES as history grows, so a
  feedback loop is easier to spot by its changing period than its rate.
- **The preload strips the Electron event** — renderer listeners must be `(payload) =>`; 11 written
  `(_e, payload)` silently never fired. `on` is now one-param, so it is a compile error.
- **A broadcast that early-returns on the empty case can never clear a loading flag** — the failure
  case is exactly the case that gets no message.
- **One slot per chat is wrong wherever the subscriber is per-MESSAGE.** Three permission registries
  were `Map<number, handler>` while the approval card renders per assistant message, so
  last-registration-won and an unmounting message could leave the chat with **no handler at all**.
  Four dispatch sites, not one — the in-band chat-stream path is easy to miss.
- **The tool DEFINITIONS live inside the first prompt-cache breakpoint**, so growing them mid-session
  invalidates the entire cached prefix. That is why tool reveal tiers **descriptions per MODE** rather
  than laddering. And **a pointer cannot replace a correction**: descriptions that steer away from a
  known failure belong in `NEVER_TRIM`, because a model about to make the mistake does not know to
  call `tool_help` first.
- **`simplifyToolParametersForProfile` keeps only the first THREE optional params** — a fourth is
  invisible to exactly the weak models that need it. A schema-level `required` array is tool-WIDE, so
  per-operation requirements must be enforced inside the handler.
- **`ai@7`'s `response.messages` is final-step-only.** Any turn whose tool call ran in an earlier step
  loses its entire native tool exchange, and the next turn carries no `role:"tool"` history. Same
  types, same shape; only the native-history evals caught it. Use accumulated `responseMessages`.
- **One version-agnostic model-type alias, never a union.** Seven files spelled
  `LanguageModelV2 | LanguageModelV3` and needed a hand-edit every SDK major; `AtlarixLanguageModel`
  makes the next spec bump free.
- **A raw NUL byte makes ripgrep silently skip a file** in a recursive search — the `binary file
  matches` notice only prints for files named explicitly. Four of our own source files were
  unsearchable, and `git diff` showed three as `Bin`, so review could not see them either. Write
  `\u0000`.
- **Every NEW tool needs `LABELS`/`DONE_LABELS` entries and a `buildToolExpandView` branch**, or the
  card reads "Runned <tool>" and slices the body at 300 chars mid-token.
- **Guards guide via the result channel, never dead-end.** A tool that returns `success:false` into
  silence is the first domino — the completion gate then holds the turn open on the unticked step and
  offers "rewrite the whole plan" as the way out, which loses the record of what was done.
- **Truncation must not reorder.** `formatCommandOutput` emitted a fixed ~13 lines regardless of an
  80,000-byte budget, out of order, with no count of what it dropped — so sampled and complete output
  looked identical and a model re-ran the command to recover information that already fit. Two-pass
  fill is required, because the notice and the excerpt reservations depend on each other.
- **The AI SDK stack must stay on MATCHING majors** — `ai@7` + v4-spec providers, and zod moves with
  them. Never mix spec lines.
- **A sub-agent borrowing the parent's interceptor inherits the parent's `turnWorkMode`** — a QA
  worker spawned from a Build turn would get workspace-write. `preview.readOnly` is NARROWING-only,
  and `enforce` is deliberately NOT set for the mode-driven case, or every Explore/Plan/Review command
  would newly fail on a machine with no OS sandbox.
- **`resolveBrowserScope` falls back to the focused window**, so a caller that forgets
  `_ownerWindowId` silently drives whichever window the user is looking at — and retargets mid-task if
  they switch. Worse than an error, because nothing reports it.

### Auth, bans and the client

- **`useAuth.loading` cannot distinguish "signed out" from "not known yet"** — use `authResolved`.
- **Naming a column that does not exist yet in the plan SELECT makes EVERY user read as free.** The
  PostgREST error falls through to `offlinePlanOr('free')`. Deploy the migration first, or query the
  new column independently and fail open.
- **A ban blocks the whole client, not just Core.** The gate sits in front of the launcher, so BYOK
  and local models do not work while banned. Only the in-turn 403 message makes the narrower claim,
  and it is correct there. The proxy's 403 is the only enforcement that survives an old build or no
  network. `isUserBanned` fails OPEN on a failed read, deliberately.
- **Agent memory had a self-perpetuating deadlock**: the absolute store path was published only when
  notes existed, so on an empty store the agent invented a human-readable path, wrote outside the
  store, and kept the store empty. Publish the RESOLVED path unconditionally, and when adopting a
  stranded directory **read the destination back and verify the count BEFORE deleting** the source.

### Prompting and the model

- **Never publish a fillable path in a prompt.** `~/.atlarix/projects/<slug>/memory/` is an
  invitation to complete it: the agent ran `find`, took a stale copy, and broke mid-session with the
  right path in context all along. Publish the RESOLVED path and say it is the only one.
- **An error names the model that REPORTED it, not one that was ever loaded** — run the
  device × dtype matrix before diagnosing.
- **Measure the thing; do not infer it from a manifest.** vite 7+ was capped by reasoning about
  export conditions, and `require("vite")` resolves fine at 8.2.1 under both Node builds.
- **Scope by what the repo contains, not by where you last looked.** The dyad-removal manifest
  enumerated `src/` and stopped, so `e2e-tests/`, `packages/` and `src/pro/` were invisible — three of
  the four biggest finds, and the estimate was off by 15×.
- **Check REACHABILITY, not presence.** Four clusters compiled, type-checked and were imported, and
  nothing could reach any of them.
- **A test that pins the OLD behaviour must be rewritten, not deleted** — and verify a new test would
  have caught the bug, since these sit green either way until checked.
- **Verify a compiler or linter diagnostic with an isolated probe before believing its scope.** TS 7
  flagged `(x ?? y ?? undefined) ?? undefined`, which as worded would have implied a jotai/TS7 fault
  across hundreds of call sites rather than one redundant operator.
- **papaparse's delimiter auto-detection is wrong when `skipEmptyLines` is false** — a trailing
  newline skews the heuristic and a `;`/tab file parses as ONE column, silently, with
  `success: true`. And `Papa.unparse` quotes whitespace cells, so a text-based emptiness check stops
  firing; check the matrix. Set `newline: "\n"` (unparse defaults to CRLF).

### Windows-only

- **A drive-letter colon is not a field separator** (grep discarded every match), and an absolute
  glob must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine
  catches either.
- **AppContainer is deny-by-default on READS** — the inverted primitive, unfixable per-path, which is
  why the sandbox was rebuilt on Low Integrity Level. HKCU is virtualized, so `atlarix://` MUST be in
  the manifest. Linux `ABI::V2` let `truncate` bypass confinement.
- **`cargo check --target x86_64-pc-windows-msvc` works from macOS**; `cargo build` on these
  `cfg`-gated crates proves nothing.
- **`.includes("/Documents/Atlarix")` can never match a backslash path** — a managed workspace on
  Windows got the reassuring copy and then had its files deleted. Match on path segments with either
  separator, case-insensitively.
- Node 25 still breaks better-sqlite3's `llvm-lib /LTCG:INCREMENTAL` on windows-latest.

---

## ✔️ Checked and CORRECT as-is — do not "fix" these

From the 2026-08-05 hardcoding sweep and the v14.26.0 permission-surface audit. The test in every case
is *what happens when the list is incomplete*; the reasoning is in git and `DESIGN_NOTES.md`.

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
- **The permission surface is layered, not duplicated** — four duplication hypotheses, all four
  refuted by the code. `guard.ts` is not a permission mechanism at all. Do not re-open without new
  evidence; see `DESIGN_NOTES.md`.
- **`write:true` cannot turn a `qa` spawn into a writer** — `subagentWillWrite` returns
  `agentIsWriter(agent)` for a NAMED agent and ignores the flag. Non-obvious, load-bearing, pinned.
- **QA is NOT advertised in Plan mode**, deliberately: you plan before building, so there is nothing
  running to test.

---

## 🔭 Long-term — not soon

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat and calls are a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack, Discord, GitHub issues — extending the existing
  `@atlarix review` bot: mention it, it picks up the task, works in a real Atlarix workspace, posts
  the result back (near-zero switching cost; how Devin and Copilot-in-Slack win). (b) A **shared,
  observable agent session** — a war room where teammates watch one run live, drop steering comments,
  approve actions and hand off, tied to the Workforce tier. The chat shell is not the differentiator;
  the shared *agent* session is. Capture, don't build yet.

---

## 📦 Shipped — index

Full prose in [`CHANGELOG.md`](./CHANGELOG.md) (current window) and
[`CHANGELOG_PREVIOUS.md`](./CHANGELOG_PREVIOUS.md) (archive). This table is the version → trap map;
the traps themselves are consolidated above.

| Version | Shipped | Trap |
| --- | --- | --- |
| **v14.35.0** | Electron 43, Touch ID passkeys, browser-backed web search, the spec-line majors, 54 → 28 advisories, the Dyad-era removal, the ban system, four plan-tracking fixes | Two silent macOS packaging traps (SIGTRAP 133, SIGKILL 137). `response.messages` became final-step-only. A stale `CREATE OR REPLACE` body nearly broke every client write to `users`. A NUL byte makes ripgrep skip a file. `created_at` is whole seconds. The plan ledger went stale at the **round** boundary, not the step boundary — `run-agent-turn` restarts `stepNumber` at 0 per round, so a take-once queue was already drained. Measured web search: 24/29/25 results where DDG and five public SearxNG instances returned 0/0/0. |
| **v14.34.0** | Atlarix tests its own work; two windows stop fighting over one mode | A per-window decision made from GLOBAL settings put a Build turn in a read-only sandbox, across five sites, triggered by an effect on window open. Truncation was discarding 99% of its own budget and reordering. Sub-agents had **no way to ask**, which read as safety and was why they could not run commands. |
| **v14.33.0** | automations that tell the agent; `operation:"run"` | Published ≠ latest, and `curl -sS` exits 0 on an HTTP error. **Verify the artefact users reach.** |
| **v14.32.0** | native PDF parts; process-tree kill; `read_url` cache; browser panels per page load | A GLOBAL decision cannot be made from per-window state — 84 turn restarts in six minutes. Capability gating is **per MODEL**, never per provider (OpenAI accepts PDF on 15 of 47). `proc.killed` only records that you signalled. |
| **v14.31.0** | Network tab; browser runtime gating removed; session-restore hang | `Network.enable` **hangs forever** on a never-navigated tab. A `Notification` unreferenced after `show()` is GC'd mid-display → native SIGSEGV. A broadcast that skips the empty case cannot clear a loading flag. |
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it. `postinstall`'s trailing `\|\| true` guards patch-package, not the Electron install. |
| **v14.29.0** | automated Store submission; WSL Landlock confinement | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads 422 green while keeping the OLD asset. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads**. `cargo check --target …-msvc` works from macOS; `cargo build` proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows drive-letter colon is not a field separator. `path.isAbsolute("C:\\x")` is false on macOS. |
| **v14.25.0** | honest context accounting; skills on demand; one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
