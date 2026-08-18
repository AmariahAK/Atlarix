# Atlarix TODO

**Current Version:** v14.34.0 (2026-08-18) — Atlarix tests its own work (QA sub-agents), per-turn
work mode, per-mode tool reveal, and command output that stops throwing away its own budget.
**Last Updated:** 2026-08-18

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative → [`docs/CHANGELOG.md`](./CHANGELOG.md). Designed-but-unscheduled
> work → [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md). Both get a one-line pointer here and nothing
> more. Trimmed 2026-08-11 and again 2026-08-15; `git log -- docs/TODO.md` has every word.

---

## 🔨 In flight — landed, not yet released

Nothing. **v14.34.0 SHIPPED 2026-08-18** — see the release record below.

---

### v14.34.0 — what shipped and the traps it left

**Command-output truncation was discarding 99% of its own budget.** `formatCommandOutput`'s
over-cap path emitted errors → warnings → FIRST 5 LINES → LAST 5 LINES: a **fixed ~13 lines / ~550
bytes regardless of `max_output_bytes`**, which defaults to 80,000. Measured on a 20k-line build
log: 13 lines before, **1,671 lines after** (100% of budget). It also REORDERED, so for anything
log-shaped the sequence — which is the information — was unreadable, and it never said how much it
dropped, so sampled and complete output looked identical. Observed consequence: a model declared the
output truncated and re-ran the command redirected to a temp file, costing two turns to recover
information that already fit. Now head+tail filled to the budget, in order, with an explicit
`omitted N line(s)` notice and error lines from the omitted middle appended as labelled excerpts.
**Two-pass fill** is required: the notice and the excerpt reservations depend on each other (holding
back room for excerpts shrinks the body, which grows the middle they come from).

**"Allow all" was a one-shot queue drain, which is not what anyone read it as.** It cleared what was
pending, the model issued its next command, and the prompt returned — so a research turn (`curl`,
then `python3`, then `jq`, each **dangerous on its FIRST TOKEN**) needed one click per command. And
"Always allow" cannot help there: for a danger match the key is `danger:<id>` and the label is "this
command", so it never generalises. Now `approve-all-for-turn` sets a blanket on the **per-turn
interceptor** — which is why it needs no expiry logic and cannot leak: the interceptor is never
reused, so the blanket dies with the turn. Set BEFORE draining, or an operation arriving mid-drain
re-raises the prompt. Inline "Approve all files" deliberately stays one-shot (a file batch is a
bounded, visible set).

**Workspace removal: the copy hedged across two different actions.** `delete-app` only `rm -rf`s the
folder for Atlarix-managed clone roots and leaves every other path alone — but every removal warned
about deletion conditions, so taking a project off the list read as though it might erase your code.
Split into two honest messages, both in an in-app `AlertDialog` (the native `window.confirm` reads as
an OS-level warning and blocks the renderer). **And the branch was broken on Windows:** the old test
was `appPath.includes("/Documents/Atlarix")`, which can never match a backslash path — so a managed
workspace on Windows got the REASSURING copy and then had its files deleted. Now matched on path
segments with either separator, case-insensitively.

**QA sub-agents — SHIPPED, the design's own "role, not a subsystem" test finally met.** Three
decisions collapsed it from a subsystem into a role, each recorded because each deletes a limb:

- **Findings are PROSE in a prescribed shape**, not a validated structured return. There is **no
  schema-validated model output anywhere in this repo** (v13 removed handoff schemas on purpose), so
  a parser + validator + re-prompt loop would have been the only genuinely new machinery in the
  batch — and the models likeliest to emit malformed JSON are the weak ones the contract exists for.
  It also needs **zero rendering**: a worker's final message already renders as markdown in the
  `SubAgentRunCard` dialog and via `buildDelegationView`. A JSON payload would be a raw blob in
  both, needing a new `ToolExpandView` kind + a `subagent_findings` event + a reducer branch.
  **Measure before building the validator** — script a weak model over a multi-item contract and
  count dropped items.
- **No `http_request` tool.** Its three justifications were: curl hands over the shell, a native
  tool returns structured evidence, it can be origin-bound. With the terminal granted and egress
  unrestricted, 1 and 3 are moot; 2 survives but a command's output is **harness-recorded**, not
  model-narrated, which is the property the contract needs. QA already reaches HTTP three ways.
- **No browser gate and no egress grant** — owner's call, treat it as a real agent. Recorded
  consequence: `browser_interact` has **no approval path at all** in any mode, so `DESIGN_NOTES`'s
  "destructive interactions go through the existing approval path" describes something that does not
  exist. And this is the first feature whose actions leave the machine, while our containment story
  is write-confinement, which says nothing about egress.

**The prerequisite was a channel, not a guard.** Sub-agents had no permission interceptor, which
reads as safety and was actually why they could not run commands: a worker with no way to ask is
either mute or unsupervised. They now borrow the interceptor of the turn that spawned them —
`getInterceptorForChat` — which is sound because a sub-agent runs strictly between
`registerInterceptor` and the turn's end and nothing ever unregisters. That inherits the card, the
danger gate, the OS sandbox, escalation-on-denial, the terminal tab and Stop-cancellation with
**zero new execution code**.

**The trap inside that:** borrowing the parent's interceptor inherits the parent's `turnWorkMode`, so
a QA worker spawned from a Build turn would have got **workspace-write**. Fixed with
`preview.readOnly`, a NARROWING-only per-request override. `enforce` is set for the caller-forced
case (so it fails rather than running unconfined) but **deliberately NOT for mode-driven read-only** —
that would newly refuse every Explore/Plan/Review command on a machine with no OS sandbox.

**`write:true` cannot turn a `qa` spawn into a writer** — `subagentWillWrite` returns
`agentIsWriter(agent)` for a NAMED agent and ignores the flag. Non-obvious, load-bearing, now pinned.

**A latent bug fixed on the way:** `resolveBrowserScope` falls back to the FOCUSED window then the
first window, and the delegation wrapper never injected `_ownerWindowId` — so a sub-agent's browser
calls silently drove whichever window the user was looking at, and retargeted mid-task if they
switched. Worse than an error, because nothing reported it.

**Plan title now reaches the MODEL** (`context-sections` ledger + both `readPlan` returns). Storing
the column fixed the panel and left the agent reading a scraped heading — so the half that mattered
on resume was still broken. **Delegation now marks plan steps** in_progress on hand-off, done on
accept.

**QA is NOT advertised in Plan mode**, deliberately: you plan before building, so there is nothing
running to test. Four advertising sites, not six.


**Per-turn work mode, plan titles, per-mode tool reveal.** Landed, full suite green
(360 files / 3021 tests), NOT yet verified in a packaged app.

- **A per-window decision was being made from GLOBAL state** — the exact mirror of the v14.32.0
  trap. `buildRunCommandSandbox` re-read `workModePreference` from the one global settings file,
  so a second window opening in Explore flipped a first window's in-flight Build turn to a
  read-only sandbox mid-command (`cannot lock ref 'HEAD' … Operation not permitted`). **Five
  sites, not one**; three of them also ignored `workModeOverride`, which gave unattended
  automations Build-mode gating. The turn's mode is now a constructor arg on
  `PermissionInterceptor` and the single source everywhere else.
- **The trigger was an effect, not a click.** `ChatIntentSelector.tsx:100-106` force-writes the
  global mode to `ask` whenever the chat chrome is read-only, so *merely opening a window* stomped
  it. And `settings_handlers` broadcasts nothing, so the first window kept displaying **Build**
  while running read-only — which is why it read as a git problem.
- **Plan titles are a stored column** (`0073_session_message_plan_title`). The old code spliced
  the title into the markdown only when the body did not start with `#` — true of `## Goal` — so
  the title was discarded for most models and the scraper returned the word "Goal". `title` is now
  required to CREATE a plan, enforced per-operation inside `writePlan` (the schema's `required`
  array is tool-wide and would have rejected every `read`/`update_step` call; property-level
  `required: true` hoists into that same array, so neither could work).
- **`title` was invisible to every weak model** — `simplifyToolParametersForProfile` keeps only
  the first THREE optional params, and `title` was fifth. Reordered to `content, title, planId`.
- **Per-mode tool reveal is back, tiering DESCRIPTIONS not tools.** v13 deleted the old reveal
  because 22 tools is a small surface — correct about the count, wrong about the cost: the
  descriptions were ~28k chars ≈ 7k tokens *every turn*. Measured saving now **1,700–2,150
  tokens/turn** per mode. Names and schemas always bind, so nothing is unreachable and nothing is
  lost to compaction; the full text arrives via `tool_help` as a tool RESULT, never in the tools
  array — **the tool definitions live inside the first prompt-cache breakpoint**, so growing them
  mid-session would invalidate the entire cached prefix. That constraint is what makes the tiering
  per-MODE rather than a ladder.
- **A pointer cannot replace a correction.** `capability-trim.eval` caught the tiering stripping
  `browser_inspect`'s anti-lure wording (v14.8.9, added for an OBSERVED bug). A model about to make
  the mistake does not know to call `tool_help` first — so descriptions that steer AWAY from a
  known failure are now in a documented `NEVER_TRIM` set. Add to it only with that justification.
- Also: guard now logs both `INVALID_PARAMS` paths (three failed `edit_file` calls left NO trace);
  `proposals` resolves an id missing its `prop_` prefix; `update_step` tolerates trailing junk on
  `step_text` (narrower than falling back to `step_index`, which would tick the WRONG step — an
  existing test correctly pinned that and was kept); `toolset-golden` now covers `debug`/`review`.
- **Dead code removed:** `getEffectiveChatMode` (0 callers, and its "read settings live" comment
  was the pattern that caused the bug), `getOptionalWorkspaceTools`, `plans:create`,
  `plans:list-by-session`, `plans:append-step` + its client method, the Plan panel's *Add step* and
  *Mark built* buttons. The `mode-prompt-bundle` prompt that told Build mode it had "all workspace
  tools via progressive reveal" was a **live falsehood** since v13 — now describes what happens.

**OWED before release:**
- [x] **Packaged-app pass — DONE by the owner before the v14.34.0 tag.** The two-window repro, a
      plan from a `## Goal` model, the weak-model `title` check and a real QA run were all exercised
      by hand in the packaged app. Recorded because the two prior releases were verified the same way
      and this project treats "self-test passed" and "someone used it" as different claims.
- [ ] **Measure contract drift** — script a weak model over a multi-item coverage contract in
      `tests/agent-evals` and count dropped items. That number, not reasoning, decides whether the
      validated structured return ever gets built.
- [ ] **Run the session-load diagnostic** — `ATLARIX_DIAG_SESSION_LOAD=1` (main) +
      `localStorage["atlarix:diag:session-load"]="1"` (renderer), open the 1.43M-token session,
      record the four numbers here. Ruled out already: NOT summarisation (zero compaction events in
      13h of log) and NOT tiktoken (memoised + delta-cached). Prime suspect is
      `workspace_session_handlers.ts:751` — `parseDisplaySnapshot` per row on the main thread, over
      a synchronous select with `SESSION_LOAD_MESSAGE_LIMIT = 100_000`. **A loading screen alone
      cannot fix it**: the overlay exists and cannot paint because nothing yields.
- [ ] Confirm `[prompt-cache]` still shows large `read=` on later turns in a mode. A `write=` that
      jumps every turn would mean the tiering is invalidating the prefix.

---

### Previous release — traps worth keeping

**v14.33.0 SHIPPED 2026-08-17** — automations that actually tell the agent, plus
`operation:"run"`. 12 assets, both update feeds, MSIX submitted. Both fixes verified by hand in
the packaged app before release.

**It shipped as a DRAFT first.** `publish-release` PATCHed `draft:false` with a bare
`curl -sS`, which exits 0 on an HTTP error — GitHub 503'd mid-incident, the step went green,
every job went green, and the release sat unpublished with all 12 assets attached. Published by
hand; the step now retries and READS THE RELEASE BACK before passing. Third instance in one day of
the same class: **a step that reads as success while the thing did not happen.**

**Then it published but was not `latest`.** Draft cleared, 12 assets attached — and
`/releases/latest` still resolved to v14.32.0, so the launchpad, the download redirect and the
auto-updater all went on serving the previous version. GitHub picks latest by **`created_at`**,
and `atlarix-releases` is a release host with ONE commit — every tag points at it, so every
release ties on `created_at` (`2026-07-26T19:32:39Z`) and the tie never broke forward.
Fixed with `make_latest` on the publish PATCH plus a read-back against `/releases/latest`
itself. **Publishing is not the last thing that has to be true — being latest is.**

**Two previously-unverified fixes are now confirmed:** notes written at creation (body came back
1,820 chars, not the ~560 placeholder) and the regenerated `RELEASES_TOKEN` (headless resolved
the release AND an asset id; `headless-bench` serves 14.33.0 again).

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

### v14.32.0 — the process-tree kill on Windows
- [ ] `taskkill /pid <pid> /T /F` replaces the SIGTERM-to-direct-child that left grandchildren
      running. **Reasoned from documented behaviour, not observed** — same posture as the v14.31.0
      notification fix. macOS/Linux are covered by a real-process test
      (`src/__tests__/kill-process-tree.test.ts`), which is skipped on Windows.
- [ ] Confirm: start a dev server through `run_command`, cancel it, then check Task Manager /
      `netstat` that no node process survives and the port is free. Failure looks like a port still
      held after the UI says the command stopped.

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

- **A plan switcher in the Plan panel.** v14.32.0 stopped session restore seizing the panel and
  gave the tab a badge instead — but the panel still shows only `getLatestPlanArtifact`'s
  `rows[0]`, the NEWEST plan, with nothing naming which one it is. A session with three plans
  therefore presents one as though it were *the* plan. Older plans stay reachable as inline cards
  in the transcript, so nothing is lost; what is missing is the panel saying **which** plan it is
  showing and letting you switch. Needs `plans:list-by-session` (already exists,
  `plan_artifact_handlers.ts:93`, currently called by nothing) plus a picker in
  `PlanExecutionPanel`.

Full reasoning in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md). One line each so this file stays a
queue, not a design doc.

- **QA sub-agents** — up to 3 declared *surfaces* (web/api/mobile/mcp/cli) that exercise the running
  app and report evidence-backed findings. Gets the requirement, **not the diff** — independence of
  judgment is the point. A scoped `http_request`, not the terminal. Load testing is an explicit
  non-goal. **Settled 2026-08-17:** coverage workers (QA, implementer) get an enumerated contract in
  the spawn payload and return one validated entry per item — no check-off tool, because self-report
  is unverifiable exactly on the weak models it would be added for.
- **Smaller upstream-review items — AUDITED 2026-08-17, four of ten were real.** Native PDF parts,
  the orphaned-grandchildren half of `run_command` containment, malformed tool-arg handling and the
  `read_url` cache all shipped in v14.32.0. **Deleted:** approval notifications (already shipped —
  `permissions/handlers.ts:134`). **Shrunk:** `llama-server` is now only about llama-server, since
  Ollama and LM Studio already resolve their real context windows via
  `resolve-model-context-limit.ts`; nested-repo trust is prompt-injection weight only, because hooks
  were deleted and no `.atlarix` file is shell-executed any more. What remains:
  - **`run_command` memory/CPU containment** (cgroups / Job Objects). The orphan half is done; this
    is the runaway-build half, and no observed failure yet.
  - **`llama-server` `/props`** for the true `n_ctx` and chat template. Reachable today as a custom
    OpenAI-compatible endpoint, just falling back to heuristics — one provider, not a systemic bug.
  - **Nested-repo trust on mid-session clones** — does a repo cloned mid-session re-trigger
    authority-file approval? Prompt injection, not RCE.
- **Needs evidence before it is worth scheduling** (demoted from the list above, so the queue does
  not imply they are ready):
  - **Per-model sampling defaults.** The hook already exists — `getTemperature` omits the param for
    models that reject it and honours a per-model override; everything else gets `0`. Populating
    overrides needs a model we can show is hurt by `temperature: 0`, which we do not have.
  - **Windows path-validation matrix** (`\??\`, `\\?\UNC\`, 8.3 names, `C:relative`). We have scar
    tissue here, but no evidence of an exploitable path — writing the matrix may find nothing.
- **Chore-model routing stays OPT-IN.** `lib/summarization_model.ts` already offers
  `"same"` (default) or `"custom"`, and titles + compaction both route through it. Defaulting Core
  users to Core 1 would silently change what they are paying for; left as the user's explicit choice.

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

## ✅ RESOLVED — the headless bundle publishes again (closed at v14.33.0)

**`Atlarix Headless` failed on the `v14.32.0` tag, twice.** The desktop release was unaffected —
12 assets, all platforms, published — but `headless-bench` on `atlarix-releases` was left holding
the **v14.31.0** tarball, so the benchmark harness was a release behind.

```
Unexpected error fetching GitHub release for tag refs/tags/v14.32.0:
HttpError: Resource not accessible by personal access token
```

**What is ruled out:**
- *Not* a draft-vs-published race — re-run AFTER the release was published, failed identically.
- *Not* a broken `RELEASES_TOKEN` — `create-draft` uses the **same action, same token, same target
  repo** and succeeded in the same run, as did all 12 asset uploads.
- *Not* a config change — headless succeeded on the previous **9** release tags with this config.

### ROOT CAUSE — `RELEASES_TOKEN` cannot READ releases in `atlarix-releases`

**This needs the owner; there is no workflow-side fix.** Proven across three attempts in a
verification window on 2026-08-17:

| Attempt | Result |
| --- | --- |
| `softprops/action-gh-release@v2` | 403 *Resource not accessible by personal access token* on GET release-by-tag |
| `gh release view headless-bench` | **"release not found"** — for a release holding 35 assets since v13.7.0 |
| `gh release upload headless-bench --clobber` | **"release not found"** — `upload` resolves the tag first, so it is also a read |

Meanwhile **every WRITE succeeds**: `create-draft` (POST /releases), `gh release create` (reached
422 *already exists*, so it authenticated fine), and all 12 asset uploads — those use the
`upload_url` create-draft *returns*, so they never look anything up. That asymmetry is the whole
diagnosis.

- [ ] **Grant `RELEASES_TOKEN` `Contents: Read and write` on `AmariahAK/atlarix-releases`** (a
      fine-grained PAT with write but not read produces exactly this). Then re-run *Atlarix
      Headless* so `headless-bench` carries the current version.
- My first theory — the unpinned `softprops@v2` floating to v2.6.2 — was **wrong**, and testing it
  is what surfaced the real cause. Two changes from it were worth keeping anyway:
  `headless.yml` now uses plain `gh` (no ref-resolution magic, and it fails with a message naming
  the token), and `release.yml` pins the action to v2.6.2.

**Related, same root cause — the release NOTES.** `announce-release` edited notes in after
publishing, which is a read, which is why v14.32.0 shipped with the "See CHANGELOG.md"
placeholder. Fixed properly: `create-draft` now checks out the repo and writes the real changelog
into the body **at creation time** via `body_path`, so no read is ever needed. **Unverified — it
only runs on a real tag**, so first proof is the next release.

## ⚙️ Actions storage — the second billing trap

**2026-08-17: Actions storage hit 100% (0.5 GB account allowance).** Different failure from the
2026-08 billing block, and it does not look like one — there is no dead workflow, just an email.

**Cause, measured not guessed:** all nine live artifacts were `atlarix-msix-x64`, 163–326 MB each,
at **14-day** retention — 2.2 GB total. Nothing downloads that artifact: **Store submission is
automated and reliable**, running in the same job straight from `out/msix/`.

**Fix:** the upload is now CONDITIONAL — `workflow_dispatch` (where nothing submits, so the
artifact is the deliverable) **or** `steps.store_submit.outcome == 'failure'` (where it becomes the
only copy of an already-built package, since submission is `continue-on-error`). In the normal case
a tag now uploads **nothing**. Retention 14 → 2 days for when it does. The upload step had to move
*after* submission to read its outcome, and the submit step gained `id: store_submit`.

**The diagnostic**, which is worth keeping because the email doesn't tell you what filled it:
```
gh api "repos/AmariahAK/Atlarix/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired==false) | "\((.size_in_bytes/1048576)|floor) MB  \(.name)"' | sort -rn
```
- [ ] Delete the existing MSIX artifacts to free the 2.2 GB (owner call — see below).
- Rule of thumb: an artifact nothing DOWNLOADS is a convenience copy, and its retention should be
  days, not weeks. `landlock-helper` is the counter-example — it IS consumed, and is already 1 day.

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
| **v14.32.0** | native PDF parts; process-tree kill; type-coerced tool args; `read_url` cache; browser panels per page load; system-wake admission control | **A decision that is GLOBAL cannot be made from per-window state, however carefully it is guarded.** Three renderer guards (a jotai store + two hook refs) all looked correct and were all blind across windows, while the listener they protected keyed on the chat id in the EVENT — so a second window woke a chat another window was mid-turn on, 84 times in six minutes. Also: the runaway ACCELERATED (0.75s → 6.5s cycles) because each discarded turn lengthened the history — a feedback loop is easier to spot by its changing period than its rate. And a refused dispatch must not settle through `onEnd`, because `onEnd` is the auto-wake itself. A **provider-level** capability allowlist is wrong wherever a provider's catalog is mixed — OpenAI accepts PDF on 15 of 47 models, Google on 21 of 41 — so gate per MODEL and let unknown fall back to the old path. `proc.killed` only records that YOU signalled; check `exitCode`/`signalCode` for whether it actually died. A test that pins the OLD behaviour (the console card labelled with the *latest* url) will fail the fix and must be rewritten, not deleted — and **verify a new test would have caught the bug**, since these all sat green either way until checked. |
| **v14.31.0** | Network tab; browser runtime gating removed; session-restore hang; notification crash | `Network.enable` **hangs forever** on a tab that has never navigated — attach resolves, the command never does, no error at all; prime `about:blank` first and time-bound every CDP command. A `Notification` you stop referencing after `show()` is collected while the OS is still displaying it, and the teardown races the daemon's — a native `SIGSEGV` no JS handler can see. A broadcast that early-returns on the empty case (`if (!s) return`) can never clear a loading flag, so **the failure case is exactly the case that gets no message**. |
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it, not one that was ever loaded — two diagnoses were wrong before the (device × dtype) matrix settled it. And `postinstall`'s trailing `\|\| true` guards **patch-package**, absent from the pruned tree, not the Electron install; re-parenthesising it broke Windows packaging at tag time. |
| **v14.29.0** | automated Store submission, WSL Landlock confinement, sandbox path fixes | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads **422 green while keeping the OLD asset** — delete the draft before re-tagging. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads** — the inverted primitive, unfixable per-path. `cargo check --target x86_64-pc-windows-msvc` works from macOS; `cargo build` on `cfg`-gated crates proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event — renderer listeners must be `(payload) =>`; 11 written `(_e, payload)` silently never fired. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows **drive-letter colon** is not a field separator (grep discarded every match); an absolute glob must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine catches either. |
| **v14.25.0** | honest context accounting, skills on demand, one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
