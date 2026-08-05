# Atlarix TODO

**Current Version:** v14.25.0 (2026-08-04) — the context meter counts what the model actually
holds, skills are read on demand instead of pasted every turn, and work reaches beyond one folder.
**Last Updated:** 2026-08-05

## 🚧 IN PROGRESS (unreleased) — one path rule, memory that compacts, cross-repo revert

**One spelling for reaching another project.** The four file tools disagreed: `glob`/`grep` took
`../sibling` and absolute, `read_file`/`edit_file` took absolute only and threw on `../`, and `glob`
rejected `..` inside the *pattern* with "Use a path within the project" — false since v14.25.0, and the
one message the model actually hit. Observed cost: it abandoned the tools for `pwd`/`ls`/`find` and then
guessed the wrong parent directory. Now **absolute is canonical, `../` is absorbed**, all four resolve
identically, and the rule is stated once via `shared-fragments.ts` into AGENTS.md, both sub-agent skills
and all three `BUILTIN_AGENTS` prompts — with the WRITE half split out so the read-only explorer is
never told about `edit_file` it cannot call.

**Memory compacts; it is not capped.** Nothing is ever refused for size and nothing is deleted to make
room. Past 25 MB per project, `planMemoryCompaction()` names the largest notes (never `MEMORY.md`) and
asks for a rewrite that is *more accurate about the file or feature it concerns*. A pending write counts
in place of the note it replaces, so a shrinking rewrite reads as progress on that same call.
- The signal is a **flag, not a lesson**: it rides the memory header line already being paid for
  (`[26.0 MB — compact a.md, b.md (see guides/memory)]`). The first version pasted a 147-token paragraph
  into **every turn** until the store shrank — the payload-instead-of-index mistake v14.25.0 existed to
  undo. Measured 147 → 24 tokens/turn (84%); guard tests fail if instruction prose creeps back in.
- The eager `mkdirSync` that created a memory directory for **every workspace path the app ever saw** is
  gone (lazy now). It had put **435 empty `…atlarix-grant-…` directories in the developer's real
  `~/.atlarix/projects/`**, because the test suite builds temp workspaces; `vitest.setup.ts` now points
  memory at a temp dir so no test can reach `~/.atlarix`.

**Cross-repo edits are revertible.** Outside paths were dropped before reaching `captureSnapshot` (one
`git add` at `cwd = workspace` aborts on a path outside its work-tree, which had destroyed the
in-workspace snapshots beside it) — so an approved edit to a granted sibling silently had **no Revert**.
`captureSnapshotAcrossRoots` groups a turn's paths onto the primary workspace plus each granted root and
captures each against its own shadow work-tree; revert/list/exists iterate roots. Ungranted absolute
paths are still dropped. Per-root locks — wrapping the captures in the primary's lock deadlocks on
`captureSnapshot`'s own chain.

**The sandbox says it was there.** See the deleted-supervisor entry below.

**`auth:enforce-workspace-limit` runs once per session.** It DELETES workspaces, and ~24 `useAuth`
consumers each invoked it on one sign-in (five log lines observed). It survived only because
better-sqlite3 is synchronous, so later copies saw the post-delete state and no-op'd — a destructive
operation racing itself. Coalesced + remembered in the handler, cleared on sign-out, failures not
remembered. Fixed in main, not the hook: 24 call sites means re-deriving the invariant at the 25th.

**Session load: measured, and my hypothesis was wrong.** Every stage suspected of the macOS beach ball
totals ~550 ms on the real 44-message / 4.54 MB session (DB read 5 ms, IPC clones 11 ms, display
hydration 31 ms, re-parse 37 ms, shiki 76 ms, token count 345 ms), of which only the token count blocks.
**Root cause still unknown** — instrumentation is in place behind `ATLARIX_DIAG_SESSION_LOAD=1` (main) /
`localStorage["atlarix:diag:session-load"]` (renderer), including a `state → painted` span; it needs one
session-open in the packaged app. Landed anyway because each is a defect on its own merits: the renderer
no longer ships the whole payload BACK to main (ids only; the old channel deleted), the hydration pass
that discarded `threadFromSnapshot`'s sub-agent merge is fixed (data loss, not slowness), the load
yields so the overlay can actually paint, and `workspace-session-title.ts` no longer fetches every
message body to read one field after every turn.

## ✅ SHIPPED in v14.25.0 — honest context accounting, skills on demand, one grant list

**The meter counted the wrong thing.** `token_count_handlers` scored each message's display
prose and never `modelContent`, where the native tool history lives — so it undercounted by
every file body, grep hit and command output, which in a coding session is most of the context.
Two of its five rows were hardcoded `0`. Seven attributed rows now PARTITION the total (tool
buckets carved OUT of history, never added on top), pushed live from `onStepFinish` because
mid-turn the results exist only in main. Traps found: the delta cache froze the newest row (its
`modelContent` lands at finalize, so the id never moves); `activeSkill (truncated)` compared
trimmed against untrimmed text and fired on EVERY turn; `ContextAssembler`'s budget is
`Infinity`, so its trimReport is always empty and the "pruned" panel was dead.

**Skills → index** (`src/lib/skills/skill-index.ts`). Bodies were pasted every turn AND clipped
(`cap()` mid-file, skill 11 gone, names list cut at 10). Cost now scales with the NUMBER of
skills. GOTCHA: the frontmatter parser took only JSON-quoted arrays, so `compatibleModes: [Debug]`
fell through to scalar and silently meant EVERY mode.

**One grant list, both lanes.** Commands read `sandbox_path` DB rows; edits read an in-memory Set
nothing ever seeded — so a folder granted to a command was still refused to `edit_file`, which
threw AFTER the user approved the diff. Unified, re-read per write so a revoke bites immediately,
with Add-folder + revoke UI in Settings → Workflow.

**`cd` grants nothing.** A regex pulled `^cd <abs>` out of the MODEL's own command string and
added it to writable roots, unsandboxed. Checked against Claude Code, opencode, Codex and Cursor
— none infer scope from text the model wrote. Removed; the sandbox is now widened rather than
disabled for outside-path commands (installers still bypass, since their writes can't be
enumerated).

**Eight defects nobody was looking for:** `.atlarix/hooks/` blanket auto-approve (live in every
prior version — the agent could write a file handed to `/bin/sh -c` every tool call, no card);
eleven dead renderer IPC listeners (preload forwards only the payload; the bridge type now makes
the mistake a compile error); one outside path aborting the whole `git add` and discarding
in-workspace snapshots; extension rules matching outside the workspace; agent memory un-writable
then silently auto-approved; the prompt calling Debug mode "Fix"; grep silently matching nothing
for `../`; and a launch that rendered signed-out for seconds before flipping.

- Mid-task compaction CONFIRMED at 90% of the REAL context window, non-fatal on summarizer
  failure. Threshold extracted to `src/lib/context/mid-loop-threshold.ts` — one source, and
  testable without dragging in the summarizer/provider/keychain chain.
- Deleted: `providers/base-provider.ts` (dead StackSense port), `installed-skills.ts`, the
  orphaned `skills:get-active-for-session` IPC, the unreachable repo-skill `priority` branch.
- Tests: 297 files / 2405 green; tsc (app, main, tests) + oxlint clean; packaged self-test 4/4.
- **Still open:** `useAuth` fan-out — ~22 consumers each run their own session check, so
  "Enforcing workspace limit" fires 5× on sign-in. Wasteful, not broken; needs its own pass.

## ✅ SHIPPED in v14.24.0 — the clone dialog actually clones

A VCL reviewer (fresh Linux VM, 2026-07-31) pasted a public GitHub URL into **Clone
repo**, named the workspace, and the **Clone button was disabled with no explanation**.
They read it as "GitHub sign-in required", declined, and abandoned the rest of the
onboarding review. `canCloneUrl` required `targetParentDir`, which started `null` with no
default and could ONLY be set by completing a native directory picker — and
`chooseFolder` swallowed both cancel and failure, so a picker that never opens left the
user with a dead button and no error.

- **A destination is always the user's explicit choice — and always reachable.** The
  "Save to" field is now a typeable path input next to the picker, moved BELOW the
  URL/name fields so it sits directly above the button it gates. Nothing is prefilled and
  nothing is remembered between clones (owner's call: never guess a location). Typed
  paths are validated in main via the new `workspace:validate-parent-dir` (tilde
  expansion, absolute, existing-or-creatable, `W_OK`), since the renderer has no `path`.
  A picker that *fails* now toasts; a picker the user *cancels* stays silent.
- **The disabled button states its reason** ("Paste a repository URL to continue" /
  "Choose where to save this repository to continue"). The GitHub tab had such a hint;
  the URL tab — the default tab — had none, which is the whole bug.
- **GitHub tab is select-then-clone.** Clicking a repo used to clone immediately, so the
  destination had to live above the tabs; rows were disabled with no destination. Now it
  selects, and the tab carries the same destination + Clone button as the URL tab.
- **Any git host.** One shared parser (`src/shared/git_remote_url.ts`) replaces the two
  GitHub-only regexes, so GitLab/Bitbucket/self-hosted URLs clone instead of being
  refused as "Invalid GitHub URL". **Hard transport allowlist** (https/http/ssh/git):
  `ext::` is rejected outright — `ext::sh -c "…"` is arbitrary command execution through
  git's remote helper — along with `file://` and any argument starting with `-`.
- **SSH URLs are no longer rewritten to HTTPS.** `git@host:owner/repo.git` reaches git
  verbatim so the user's agent/keys authenticate it (`GIT_SSH_COMMAND=ssh -o
  BatchMode=yes`, `GIT_TERMINAL_PROMPT=0` so nothing blocks on a prompt). With no git
  binary, SSH fails with an explicit message — isomorphic-git speaks HTTPS only.
- **Real errors, redacted.** The clone path returned a fixed "Failed to clone repository.
  Please check the URL and try again." for every failure. It now maps auth / DNS /
  not-found / missing-git and otherwise shows git's own last lines. **All of it passes
  through `redactGitUrlCredentials`, including the `logger.error`** — the authenticated
  clone URL embeds the OAuth token and git echoes URLs in stderr, so surfacing stderr
  without redaction would have leaked tokens into toasts and log files.
- **The GitHub pre-check is a courtesy, not a gate.** It turned ANY `fetch` failure into
  "Repository not found or you do not have access to it." Now only a definitive 404/403
  stops the clone; offline/proxy/rate-limit falls through and lets git report the truth.
- **Real progress.** New `execStreaming` (spawn-based, same never-reject/exit-127
  contract as `exec`) parses `git clone --progress` stderr; `gitClone` gained
  `onProgress`, mapped into a 15–85 band. Verified live: 14 events, 7% → 100%. Before,
  a clone sat at 15% until it finished and looked hung.
- **Correct DB rows.** `githubOrg`/`githubRepo` are only set for github.com hosts — they
  mean "linked to GitHub" and build the push URL, so a GitLab clone with them set would
  have pushed to github.com. `githubBranch` comes from `gitCurrentBranch` instead of a
  hardcoded `"main"`.
- Tests: `clone-url-parse` (19), `clone-error-surface` (8), `clone-destination-validation`
  (7), `renderer/clone-dialog` (8). Full suite 250 files / 2211 tests green; tsc (app,
  main, tests) and oxlint clean.
- **Deleted:** `e2e-tests/github-import.spec.ts` drove an "Import App" modal with Local
  Folder / Your GitHub Repos / GitHub URL tabs — a UI that no longer exists anywhere in
  `src`. Dyad-era, already stale before this work.
- **Still open:** no e2e spec reaches the welcome launcher at all (`po.setUp()` navigates
  the older settings/apps shell), so the clone dialog is covered by jsdom renderer tests
  rather than Playwright. Worth a harness path for the launcher if welcome-screen
  regressions ever recur.

## ✅ SHIPPED in v14.23.0 — providers off the hardcode, a plan gate that stops fighting

### Third batch — Stop actually stops, and Revert survives it

Reported live (deepseek-v4-pro, caddy repo): the user pressed Stop mid-task because the
agent was running the wrong command. The agent kept going, re-read the file it had just
edited, concluded **the user** had made the fix, and pushed to git. Revert was unavailable
for that turn. Three separate causes:

- **Stop did not stop.** `chat:cancel`'s `response:end` carried no cancellation marker, and
  the renderer auto-wakes a FRESH turn whenever a background command or sub-agent has a
  pending result — which is the normal state right after a stop, since cancel kills only
  FOREGROUND commands. There are TWO wake sites (the `response:end` race-closer and the
  background job/task listener); both now honour a `userCancelled` end plus a
  `userStoppedChatsRef` latch, released only when the user sends a real message. Owner's
  call: background work still finishes quietly — nothing is killed and nothing is dropped.
  Results stay pending and drain into the next turn via
  `takePendingBackgroundCommandResults`, which is wake-independent.
- **Revert vanished on exactly the turn you stopped.** The pre-write bytes were on disk
  (the interceptor captures at write time), but `snapshotTurnId` was only sent on the clean
  finalize path, and `RevertTurnAction` renders nothing without it. `chat:cancel` now
  reports it via a new `streamTurnIdByChatId` map, and the renderer's store of that id was
  hoisted out of the `rawFromRef` (thinking-snapshot) branch it had no reason to depend on.
- **The harness told the model the user had made the fix.** `edit.ts` said "The file likely
  changed since you read it" on ANY near-miss, including when this turn was the thing that
  changed it — which is how the model read its own edit as the user's. Same class as the
  v14.22.0 notice work.
  - **First attempt, discarded:** a `turn-write-log` that tracked authorship so the error
    could say "YOU edited this". Wrong question, and it was **inert in production** — the
    funnel only ever injected `_scopeChatId` for the two attachment tools, so the check
    never fired. Tests passed because they supplied the id themselves.
  - **Shipped instead:** the near-miss message no longer theorises about WHY the content
    differs. It says `old_content` doesn't match and shows the candidate. No tracking at all.
  - **Plus a read-before-OVERWRITE gate** (`lib/tools/file-read-log.ts`), scoped
    deliberately to `operation:"write"` over an EXISTING file. Not to `replace`: a replace
    already carries a content-addressed freshness check (`old_content` must match, so a
    stale view errors instead of corrupting), and gating it would add a read per file to the
    path Build mode explicitly tells the agent to prefer — for a hazard already handled. An
    overwrite has no such guard and silently discards the whole file. Creating a new file is
    exempt. Hashes what the READ RETURNED, not disk, so writer sub-agents (which read their
    proposal overlay) aren't reported stale; `recordEditProposal` refreshes the record so a
    sub-agent's own second edit isn't blocked. `ATLARIX`-free, no env flag — it is cheap
    enough not to need one.
  - Considered and rejected: gating `replace` too. Six tests moved on that version, one of
    them the SWE-bench smoke test — a signal that it changed benchmark behaviour for a class
    of failure that already fails safe.
- **Confirmed, now pinned by a test:** sub-agent edits ARE revertible. `proposals accept`
  returns an `edit_file` permission envelope rather than writing, so it travels the same
  interceptor executor that snapshots `preview.path`. A test asserts the envelope shape and
  that accept leaves disk untouched — if accept ever grows a direct write, sub-agent changes
  would silently stop being revertible.

### Fourth batch — found by using the packaged build

- **Raw plan JSON leaked into the reply.** `","progress":"0/14 steps done` rendered as chat
  text. Every stripper in `answer-display.ts` needs a COMPLETE object, and the `}`-anchored
  tail strip needs its closing brace, so a truncated echo matched nothing — and `progress`
  wasn't a known result key until this release added it, so a new field became a new leak.
  New `stripTruncatedToolResultTail`, keyed to the plan tool's own field names and requiring a
  leading comma (a bare `"key":` test would eat prose containing a colon).
  - **Also fixed, pre-existing and worse:** three JSON-shaped strippers ran OUTSIDE
    `mapOutsideFences`, so a legitimate ```json fence containing `message`/`planId`/`progress`
    had its body deleted. Surfaced by a test asserting such a fence survives — the file's own
    comment says this class of corruption "split a code block's body out of its box" and had
    supposedly been fixed once already. All JSON-shaped strippers are now inside the guard.
- **No hardcoded protected-path list any more** (`file-permission-scope.ts`). It named
  `package.json`, lockfiles, `.env*`, `.pem`/`.key`/`.cert`/`.p12`, `.github/workflows/**` —
  and `drizzle.config.ts`, `src/db/schema.ts`, `drizzle/**`, i.e. **Atlarix's own layout**
  hardcoded into every user's workspace ([[atlarix-no-hardcoding-telios]]). Any match forced a
  prompt on every edit AND set `canAlwaysAllow{File,Directory,Extension}: false`, so
  `.github/workflows/*.yml` was a dead end by construction — the reported bug.
  - It also contradicted this codebase's own position for READS
    (`security/env-secret-paths.ts`: "We do NOT block files by name … like opencode /
    Claude Code, the agent reads files inside the workspace freely"). The write side is now
    consistent.
  - Nothing traded away: the approval queue + inline diff still gates every write, containment
    and symlink escapes still refused, shell credential reads still hit the danger gate, and
    stored `always_deny` rows are still enforced. Projects wanting a path to always ask use
    `.atlarix/permissions.json` — configurable, not a constant.
  - The list had **zero test coverage** (removing it broke nothing), so
    `src/__tests__/file-permission-scope.test.ts` now covers it: 28 cases asserting every
    formerly-protected path can be always-allowed AND that stored decisions still apply.
  - Dead "Protected path — only Allow once or Deny" notice removed from
    `InlinePermissionApprovals`.
- **Secret handling: no change needed.** `AGENTS.md` "## Secret handling" already says to use a
  user-pasted key and then remind them to rotate it, not to persist secrets to tracked files,
  and never to echo a value. Guidance was already correct; only the *gate* was wrong.
- **The sub-agent panel no longer collapses mid-stream.** `allSettled` flips when the last
  sub-agent finishes — usually mid-turn — and the body (up to `min-h-[14rem]`) unmounted then,
  dropping document height and jumping content below under the auto-scroll. That was the
  reported "scratchy" rendering, and it was introduced earlier in this same release. Collapse
  is now gated on `!isStreaming`: same end state, no mid-stream reflow. Summaries stay.

### Second batch (same version)

- **Project instructions and memory are POINTED AT, not injected.** `.atlarix/atlarix.md` was
  being pasted into the system prompt **twice per turn** — once by `loadAtlarixMdSection` and
  again by `buildInstructionsFromLayers` in `system_prompt.ts` — and `memory.md` had both a
  pointer AND a full-body injection. Both bodies also went through `capInject`, a **silent**
  3000-char clamp, so a longer instructions file had its tail dropped and those rules never
  applied. `capInject` is deleted; the instructions pointer names the file, its size and its
  **section headings** (so a weak model can tell whether the rules apply) and says to
  `read_file` it before changing code. `global` + `project` layers are excluded from the base
  prompt concatenation (`POINTED_AT_LAYER_KEYS`).
- **New per-note agent memory** (`src/lib/agent-memory.ts`): `MEMORY.md` index + one note per
  fact under `~/.atlarix/projects/<slug>/memory/` — outside the repo, per-developer, never
  committed. Only the index reaches the prompt, so cost scales with the NUMBER of notes, not
  their size (measured: 20 notes × 2 KB → <1 KB of index). Isolation is structural — the slug
  is the workspace path plus a hash, because slugification alone collapses `/a/b-c` and
  `/a/b/c` onto one directory. `.atlarix/memory.md` migrates in on first sight
  (non-destructive, idempotent). Convention taught on demand via `skills/guides/memory.md`.
  `ATLARIX_MEMORY=off` removes the section entirely and **the headless runner sets it**, so
  benchmark runs carry no memory surface and one task's notes can't influence a later one.
- **Core wallet: a zero cost with real tokens now charges the reserve and warns loudly.**
  `computeCostUsd` returns `0` (not `null`) when a tier's pricing block exists but resolves to
  zero, so the `!= null` check never caught it and the generation was billed **0c, silently**.
  This is the reported "GLM isn't removing credits" symptom. Note the reserve is priced from
  the SAME catalog, so it reserves 0 too — the fallback lifts to `MIN_START_BALANCE_CENTS`.
  (`atlarix-proxy`, +4 tests.)
- **The account appears on first paint.** `restoreAuthSessionOnStartup` gained an
  `onStoredSession` callback that fires the moment the stored session is read, so the UI no
  longer waits on the refresh's 400 ms retry + `[0,1000,3000]` backoff + three round-trips
  (the new test suite shows the callback firing while the same run spends 4009 ms refreshing).
  Every v13.9 resilience property preserved.
- **`reset-all` re-opens the database** (`reinitializeDatabaseAfterReset`). It closed the handle,
  unlinked the file and returned while the app kept running, so every later query threw
  better-sqlite3's opaque "connection is not open". Also removes the `-wal`/`-shm` siblings,
  which SQLite could otherwise replay into the fresh file and resurrect deleted rows.
- **The sub-agent panel collapses once every agent settles**, with the cards one click away
  (and never re-collapsing under someone reading it). Chosen over the old TODO's
  weave-inline direction — reports are LLM-to-LLM output that shouldn't grow more prominent.
- **Tools page stops advertising things that don't exist:** "all four Core models / Core 1–4 /
  Core 3-4" (the lineup is config-driven and only some slots are mapped — the live list now
  renders from `useAtlarixCoreCatalog()`), approvals "queue in the right panel" (they moved
  inline in v14.15.0), plus "section-scoped Blueprint" (tool removed 2026-06) and "team
  features" (Team tier killed in the pricing reframe) in the page header.
- **Notifications: nothing to do** — turn-complete (`permissions/handlers.ts:342`) and
  automation results (`automations/notify.ts`) both already ship. Both deliberately suppress the
  OS notification while the app is FOCUSED, and both are gated on `notificationSound.enabled`,
  so turning the sound off also kills notifications. Open question, not a bug: whether that
  single switch should be split.


- **Provider dispatch keys on models.dev's `npm` field.** New
  `ipc/shared/provider-sdk-factories.ts` (5 factories over the bundled SDKs) replaces 11 identical
  `createOpenAICompatible({name, baseURL, apiKey})` switch cases; `get_model_client.ts` goes 24 cases
  → 13 (−101 lines) and every catalog provider is now connectable without an app release.
  `CLOUD_PROVIDERS` is no longer the registry — it's a presentation + **pin** overlay
  (curated name / key-console link / free-tier / gateway prefix, plus deliberate `apiBaseUrl` /
  `npm` pins).
  - **Pins that matter:** `minimax` stays OpenAI-compatible at `/v1` (the catalog moved it to
    `@ai-sdk/anthropic` at `/anthropic/v1` — a WIRE-FORMAT change, and MiniMax-M3 is the benchmarked
    model); `deepseek` keeps `/v1` (catalog omits it); `google` prefers
    `GOOGLE_GENERATIVE_AI_API_KEY` over the catalog's `env[0]`; `vertex` has no catalog row at all.
  - `envVarName` became an ordered **list** (`envVarNames`) — models.dev publishes several per
    provider and the old `env?.[0]` picked the one Google's SDK does not read.
  - Deleted the closed 21-entry provider tuple in `schemas.ts`. Its one consumer now filters the live
    provider list, which also fixes "no provider configured" for a user whose only key belonged to a
    catalog-only provider. `PROVIDERS_WITH_TOKEN_BUDGET` (19-entry allowlist) is likewise derived.
  - Guarded by `src/__tests__/provider-dispatch-pins.test.ts` (40 assertions) — provider dispatch
    fails SILENTLY, so the resolved URL + SDK for every formerly-hardcoded id is pinned to what
    shipped.

- **The plan gate no longer forces redo on work the model cannot do.**
  `plan-completion-gate.ts` counted any step that wasn't `done` as remaining, so a step needing the
  USER held the turn open and was re-nudged up to 6 consecutive / 12 per turn. New `external` step
  state (marker `@`, no migration — step state lives in the markdown): the gate now fires on
  `todo`/`in_progress` ONLY. `blocked` also releases the turn but does **not** license a success
  claim; `external` does, and requires a `reason` appended inline as `— needs you: …` (idempotent,
  stripped when the step moves off `external`) so it survives reload and shows in the card, the
  ledger and the panel. Guidance rides the `plan` tool description only — no new mode-header lines.
  - **Also fixed:** `markAllChecklistStepsDone` — the end-of-turn safety net — flipped `blocked`
    steps to `done` on any Build turn that wrote a file, converting "I'm stuck on this" into "done".
    Pre-dated `external`; it now closes actionable steps only.

- **Sub-agent results render as markdown.** All four sites (`SubAgentCard`, `SubAgentRunCard`,
  `HandoffResultCard`, and the expand panel) used raw `whitespace-pre-wrap`, so a markdown report
  arrived as one unstyled blob. `buildToolExpandView` had **no `task` branch at all** — the report
  fell through ~15 tool families to a ~300-char slice of the raw envelope. Added a `task` branch and
  a `markdown?: boolean` on the existing `text` view kind (fixes every text-shaped tool, not just
  `task`). Envelope unwrap extracted to renderer-safe `lib/chat/subagent-summary.ts`.

- **`AssistantMessageBody`'s two branches share one trailing component.** The five trailing concerns
  are emitted once by `MessageTrailing` instead of twice. This closed two MORE instances of the
  documented bug class: `postStreamSubagentItems` was interleaved-only, and the legacy branch built
  its trailing answer WITHOUT `citationSources` so inline `[^n]` markers never resolved there.
  `assistant-message-trailing-parity.test.tsx` renders one fixture through all three branch
  configurations and was verified to go RED when the legacy trailing is removed.

- **`preview_test` → `browser_test`.** It drives a browser tab; "preview" referred to the pane
  deleted in v14.15.0. The registry gained an `aliases` mechanism (separate map, so `getAll()` keeps
  listing each tool once) — the old name still resolves for persisted sessions and is advertised
  nowhere. Added the missing activity labels, which were hitting the "Runned <tool>" conjugation
  fallback.

- **Docs:** report-only prompt-surface audit
  ([`PROMPT_SURFACE_AUDIT_v14.23.0.md`](./PROMPT_SURFACE_AUDIT_v14.23.0.md)); corrected the stale
  AI-SDK constraint in the dependency-triage entry (repo is on `ai@6` + v3 providers, not
  `anthropic@2.x` + `ai@5`); marked the DB shutdown-race entry fixed (it already was) and recorded
  the adjacent `reset-all` gap found while verifying it.

## ✅ SHIPPED in v14.22.0 — edits that don't corrupt files, and a harness that tells the truth

- **`edit_file` escape symmetry.** Whatever normalization located the match is now applied to the
  replacement, so an escape-normalized match no longer writes literal `\"` into a Go raw string.
- **Notices name the matching strategy** instead of always claiming indent/EOL tolerance —
  `match.strategy` was returned and discarded, and the wrong explanation cost ~25 turns of
  misdirected debugging.
- **A fuzzy match no longer auto-executes.** A guessed edit reaches the human diff.
- **Path aliases absorbed in the guard** (`file_path`/`filePath`/`filename`/`file`), and the prompt
  clause that fought the training prior is deleted.
- **Plan JSON no longer leaks into replies**; `plan` gained a real card (title, status, progress,
  checklist).
- **Prompt restructure.** Guidance relocated onto tools (browser, git policy, web research), mode
  rules cut from four live copies to two, six prompt/harness contradictions fixed, mode labels
  derived from the registry. Build-mode header −28.9% with no rule removed.
- **Fixes:** paste-only first message now yields a session title; a restored workspace folder
  recovers without an app restart; a finished background job stops asking to be re-checked;
  `run_command` no longer says "Successfully executed" beside a non-zero exit;
  `BrowserWindow.getFocusedWindow` stubbed (a real headless gap).
- **New standing guard:** no mode's prompt may name a tool that mode cannot call — it caught three
  of the six contradictions above.

## 🔜 NEXT SESSION — Agent-visible automations

**Automations are fully built and completely invisible to the agent.** `grep -rn "automation"` across
`src/prompts/system_prompt.ts`, `chat_stream/context-sections.ts`, `AGENTS.md` and every skill returns
**nothing** — no tool, no prompt line, no notification. Meanwhile the feature is substantial: the
`automations` + `automation_runs` tables, three trigger kinds (`schedule` cron, `github`
new-pr/review-requested/ci-failed, `mcp` tool poll), a runner, pollers, auto-approve, notify, and a run
feed the human drives entirely by hand in `AutomationsTab`. The actor best placed to notice "you have
checked CI by hand three times today" cannot see that automations exist.

**Shape (owner-approved, 2026-08-05):** think of an automation as a background task that persists —
same lifecycle affordances, but for logs, CI and MCP polls.

- **Notify only. Atlarix informs; the AGENT acts.** No write-capable automations: `runMode` stays
  `notify-only | read-only`. (`worktree-write` was removed in v14.21.0 with the sub-agent worktree and
  is deliberately not returning — an unattended agent making changes on a timer is a different product,
  and the unattended read-only allowlist below is still unsolved.)
- **Nothing is ever killed, and there is no lifetime cap.** Both guarantees already hold and must be
  preserved rather than built: a background job is **"NEVER auto-killed"**
  (`background-commands.ts:115`) — the 3-minute stall threshold is advisory-only, fires once, and
  `killBackgroundJob` runs only on an explicit agent/user cancel (plus `killAllBackgroundJobs` at
  shutdown). Automations have no kill path at all; they are polled. An automation or job may run as long
  as it likes.
- **Wake-ups: 4 h per call, re-armable indefinitely.** Also already true — `MAX_DELAY_MS = 14_400_000`
  in `lib/agent/scheduled-wakeups.ts:20`, clamped **per call**, so the agent can arm another 4 h when one
  fires and keep going. The only limit is `MAX_PENDING_PER_CHAT = 8` *concurrent* pending wake-ups,
  which does not restrict sequential re-arming. Nothing to change; automations just need to participate.
- **Leave `MIN_POLL_INTERVAL_MINUTES` (5) alone.** An earlier draft of this entry said "raise the poll
  floor 5 min → 1 hour to match background tasks" — that conflated two unrelated things and is
  **withdrawn**. It is a *rate limit* on how often we hit GitHub / an MCP server, protecting API quota;
  it has nothing to do with killing anything, and raising it would make automations poll **less** often,
  which is the opposite of the goal. The user picks any interval at or above the floor.
- **One `automations` tool**, mode-parameterised like `plan`/`mcp_call` so the standing cost is the tool
  description alone: `list` (with recent runs + logs), `create`, `update`, `stop`/`cancel`, `delete`.
- **`create`/`update`/`delete` go through the approval gate; `list` is free.** A standing, recurring,
  quota-spending job that runs while nobody is watching is a different risk class from a one-shot file
  edit, and a silently deleted automation leaves nothing on disk to notice. The gate and its card
  already exist.
- **The agent is told when a run finishes, hangs, or a poll is missed**, drained through the existing
  background-result channel (`takePendingBackgroundCommandResults`) so it lands in the next turn rather
  than interrupting one — and so it honours the v14.23.0 rule that background work never wakes a
  stopped turn. Default to surfacing runs on request plus a count in the feed; per-automation opt-in for
  push.
- **NO `allow_stalled` for automations** (asked and answered). It exists for background jobs because
  output silence is ambiguous liveness — `OUTPUT_IDLE_THRESHOLD_MS = 180_000`, comment: "output-flow =
  liveness", advisory-only, fires once. None of that transfers: an automation is silent between polls by
  construction (100% of the time at an hourly floor), and its liveness is **arithmetic** —
  `lastRunAt` + `intervalMinutes` answers "did a poll happen?" objectively, so there is nothing for the
  agent to declare. Worse, a background job's flag dies with the job while an automation is *standing*,
  so the flag would persist across sessions and silently convert "this poller is dead" into "don't
  mention it" — the worst possible failure for a notify-only feature. Detect instead: **hung run**
  (started, unfinished after N× expected duration; reported, and does not block the next poll) and
  **missed poll** (`lastRunAt` older than ~2 intervals).
- **Timers need nothing new.** `schedule_wakeup` already clamps to 60–14400s (4 h), and
  `background_jobs` already has `wake_in`/`adjust_timer`. Automations just need to participate.
- **The real win is recommendation:** having watched the user tag, wait, check CI and fix by hand, the
  agent should be able to offer to make that an automation. That is the difference between a feature
  users discover and one they don't.

## 🔭 v14.19+ — Mobile emulator toolset

**`mobile_*` tools, mirroring the browser family** — a device `target`, and **a11y-tree-first** so
it stays token-cheap (screenshots a last resort, exactly as in `BROWSER_NOTE`). Gives Atlarix real
end-to-end mobile UI testing.

- **Android — raw `adb`**, no dependency beyond the user's own SDK. `emulator -list-avds` /
  `emulator -avd <name>` to boot; `adb shell input tap|swipe|text|keyevent` to interact;
  **`adb exec-out uiautomator dump`** for the a11y tree with resource-ids and bounds (the direct
  analogue of `browser_inspect`, and what keeps this cheap); `adb exec-out screencap -p`,
  `adb install`, `adb logcat`, deep links via `adb shell am start -a android.intent.action.VIEW -d`.
- **iOS (macOS only) — `xcrun simctl` + `idb`.** simctl covers lifecycle (list/boot/install/launch/
  `io booted screenshot`/openurl) but has **no touch input**; `idb ui tap|swipe|text|describe-all`
  supplies taps and the a11y tree. **Verify idb's maintenance status before committing to it** —
  Appium + WebDriverAgent is the fallback if it has gone stale (heavier: Node server + WDA signing).
- Considered and set aside: Maestro (single binary, both platforms, but less low-level control) and
  Appium as the primary driver (one driver for both, at a much heavier install cost for users).

## ⏳ Open / deferred

### From v14.22.0

- **Packaging registry (one line, deliberately deferred).** `runNpmInstall`
  (`forge.config.ts:20-35`) spawns npm with no `--registry`, in `buildPath` outside the project,
  so a custom global registry wins and `packageAfterPrune` dies with `E401`. Until it lands,
  `npm run package` needs `npm_config_registry=https://registry.npmjs.org/`. Held pending the
  owner's account migration.
- ~~**Report-only audit sweep**~~ — **DONE in v14.23.0**, written up in
  [`docs/PROMPT_SURFACE_AUDIT_v14.23.0.md`](./PROMPT_SURFACE_AUDIT_v14.23.0.md).
  - ~~"Named sub-agents are under-prompted"~~ — **STALE, corrected 2026-08-05.** The entry cited
    `EXPLORER_PROMPT` at 338 chars and `implementer` at 108. Measured today they are **909 / 819 / 864**
    (explorer / architect / implementer), and `IMPLEMENTER_PROMPT` now explains the proposal mechanism
    in full — the specific gap the audit named ("never reads the 44 lines of `subagent-writer.md`
    explaining that its edits become proposals") no longer exists.
  - What the entry was *right* about is drift risk from two near-verbatim sources, and that is now
    handled structurally: `shared-fragments.ts` holds the text that must read identically, and all
    three `BUILTIN_AGENTS` prompts plus both sub-agent skills render from it
    (`{{REUSE_FIRST_LADDER}}`, `{{OUTSIDE_WORKSPACE_PATHS}}`, `{{OUTSIDE_WORKSPACE_WRITES}}`), with
    tests asserting each fragment reaches every consumer that should have it — and only those.
  (Compaction prompt: 2,298 B vs opencode's 823 B — measured, no change recommended, see the doc.
  `<system-reminder>` sites: **22**, not 16.)
- ~~**`preview_test` is misnamed.**~~ — **DONE in v14.23.0**: renamed to `browser_test`. The registry
  gained an `aliases` mechanism (separate map from `tools`, so `getAll()` still lists each tool once)
  so the old name resolves for persisted sessions while being advertised nowhere — per the v14.22.0
  rule, absorb the alias, don't prompt against it. Covered by
  `src/__tests__/tool-name-aliases.test.ts`.

### ~~🔀 `AssistantMessageBody` two-branch duplication~~ — RESOLVED v14.23.0

`AssistantMessageBody.tsx` returns from two structurally parallel branches — interleaved
(`useInterleavedTimeline = contentDrivenThread || isStructured`) and legacy — and features get wired
into one but not the other. **Two bugs from this class shipped in a single batch:**

- The web-search **citation strip** was mounted only in the legacy branch, so it never rendered for
  the turns that actually had citations (every search emits a tool tag → interleaved branch).
- The **sub-agent round panel** was the mirror image: rendered only in the interleaved branch, so a
  round on a plain-prose message rendered nowhere. Worse, `excludeSubagentRound` — driven by
  `inlineSubagentRound`, which `resolveLiveSubagentRound` makes non-null post-stream by reading the
  COMPLETED thread — pulled the round out of the tail too, closing the one indirect route the legacy
  branch had (via `StreamThreadItemView`'s `case "subagent_round"`). Git history confirms the legacy
  branch NEVER had its own panel render; it was an omission from the split, not a regression.

**RESOLVED in v14.23.0.** The five trailing concerns are emitted once by a shared `MessageTrailing`
component rendered after each branch's middle. Collapsing them surfaced **two more** instances of
the same class, both now fixed: `postStreamSubagentItems` rendered only in the interleaved branch,
and the legacy branch built its trailing answer WITHOUT `citationSources`, so inline `[^n]` markers
never resolved on that path.

The sub-agent round **panel** deliberately stays per-branch — its position is genuinely different
(woven mid-timeline vs. after the parts), so sharing it would move it. That residual risk is covered
by `src/__tests__/renderer/assistant-message-trailing-parity.test.tsx`, which renders one fixture
through all three branch configurations (legacy, `isStructured`, `contentDrivenThread`) and asserts
the trailing elements appear exactly once in each. It was verified to fail — on the legacy branch
only, for the right reason — when the shared trailing is removed.

### Other

- **Sub-agent results still don't *continue* in the timeline** — STILL OPEN, and deliberately not
  attempted in the 2026-08-05 batch. The painful half is gone: results RENDER properly (markdown, with
  a real `task` tool card) instead of as a raw envelope slice. What remains is purely placement — they
  live inside the round-panel cards behind the expand affordance rather than resolving inline where
  they were spawned. Direction unchanged: weave settled `subagent` items via `weaveIpcItemsIntoParts`
  (`WEAVABLE_KINDS` currently excludes `subagent_round` — "panels/rounds always stay tail") and
  collapse the panel once all agents settle, so the same agent isn't rendered twice.
  - **Why it was skipped:** its entire value is visual placement, and it sits in the most
    reflow-sensitive code in the renderer — `AssistantMessageBody`'s sticky-agents / seam-offset /
    synthesized-round interaction, which has already produced one "scratchy rendering" regression from
    the panel unmounting mid-stream (fixed in v14.23.0 by gating collapse on `!isStreaming`). The
    v14.23.0 parity test guards trailing-element *duplication*; nothing guards "does it look right".
    Land it in a session that starts with the packaged app open, so each step is seen rather than
    inferred.
- ~~agent-evals flakiness~~ — **FIXED** (see the in-progress section above).

- ~~**Linux authoritative denied-path supervisor (Phase 2)**~~ — **DELETED 2026-08-05, not shipped.**
  The ptrace + seccomp(`SECCOMP_RET_TRACE`) supervisor was 258 of the crate's 429 lines, feature-gated
  off, never consumed (`--deny-report` appeared nowhere in `src/`), and **never compiled by CI**
  (`release.yml` builds default features only) — so the highest-risk-per-line code in the repo was the
  only code no automated process type-checked. It also improved DIAGNOSTICS, not security: Landlock was
  and remains the boundary.
  - Owner's call after weighing it: a kernel oracle would have made the message more precise on **one**
    OS, so it was dropped in favour of making the message **exist on all three**. macOS has no clean
    route at all (custom `sandbox-exec` profiles do not log denials; Endpoint Security needs an
    Apple-granted entitlement; `DYLD_INSERT_LIBRARIES` is stripped for the platform binaries we invoke)
    and Windows needs elevation or a signed driver — so per-OS parity was never reachable anyway.
  - **Shipped instead:** `src/lib/sandbox/sandbox-failure-context.ts`. When a sandboxed command fails and
    no path can be scraped, the model is told the sandbox was applied, whether it was read-only, the
    writable roots and the cwd — **facts only, no diagnosis.** An intermediate version tried to classify
    failures (permission-signal regexes, a vendor blocklist, a tool→cache-path table) and was deleted for
    guessing: the command's output is already in the error, and the model reads it better than a regex.
  - Git history keeps the supervisor if a real report ever shows tools swallowing paths — at which point
    we will know *which* tools, and the scraper may just need another pattern.

## 🔍 Hardcoding sweep (2026-08-05) — findings

Audit of every uppercase constant list in `src/lib` + `src/ipc` after two hardcoded lists were
deleted this batch. **The test that matters is what happens when the list is INCOMPLETE.**

**Fixed:**
- **4 of 26 live tools had no activity label** (`compress_context`, `list_attachments`,
  `read_attachment`, `schedule_wakeup`) and fell through to the generic `Running <tool>…`
  template — the documented "Runned &lt;tool&gt;" trap. Labels added, and
  `tool-activity-labels-coverage.test.ts` now fails with the offending tool's name so the
  requirement lives in the suite instead of a note. Expand views were already fine (`text`).

### 🎯 NEXT SESSION — delete the file-discovery exclusion apparatus (owner-directed)

The **only** one of the swept findings that needs active work. Deep-dived 2026-08-05; the
owner's read was right, and the mechanism is more specific than first written up.

**The finding.** `isExcludedDiscoveryRelPath` + `ALWAYS_EXCLUDE` (`ipc/utils/project-files.ts`)
and `isExcludedDir` (`ipc/utils/file_utils.ts`) are TWO parallel implementations of one
exclusion set, hardcoding `cdk.out`, `.cdk-out-deploy`, `.cdk-staging`, `.aws-sam`, `asset.*`
and **any 64-hex-character directory segment**. Added v8.2.0, presumably while working on
aws-cdk (a registered workspace here) — [[atlarix-no-hardcoding-telios]] exactly.

**Why it exists, and why that reason is obsolete.** `getProjectFiles` has three strategies: `fd`
(with `--no-ignore-vcs`, i.e. deliberately discarding `.gitignore`), `rg`, and a legacy
**synchronous recursive walk**. The exclusion list is scaffolding for the two strategies that
do not honour `.gitignore`.
- **`project-files.ts` probes `rg --version` on PATH and shells out to `"rg …"` — it does NOT
  use the bundled `@vscode/ripgrep` that `grep`/`glob` resolve via `resolveRipgrepPath()`.**
  That single line is the whole problem: on a machine with neither `fd` nor a system `rg`
  installed (the common case), discovery lands on the legacy walk, which is why the hand-
  maintained excludes are needed at all.
- It also means `@`-mention behaviour currently **differs between users** depending on whether
  they happen to have `fd` installed — the `fd` path offers gitignored files, the `rg` path
  does not. That inconsistency is worth killing on its own.

**Measured, so the trade-off is known rather than assumed.** The bundled ripgrep with the exact
flags `grep`/`glob` use (`--files --hidden --no-ignore-parent --no-ignore-global`) against a
fixture containing `.gitignore` (`.env`, `cdk.out/`), `.env`, `cdk.out/a.js`, `real.ts`:
- **excludes `cdk.out/a.js`** → every CDK name AND the 64-hex rule are redundant, since any real
  project gitignores its build output;
- **excludes `.env`** (gitignored) → matches what most users already get today, since the `fd`
  path is the outlier;
- **includes `.git/**`** (19 files) → **exactly one exclusion is still needed**, and it is
  derived from an observed need rather than an ecosystem list.

**Why the bundle does not already cover this** (it was raised, and it is the crux): the bundled
`@vscode/ripgrep` DOES cover `grep`/`glob` — they resolve it via `resolveRipgrepPath()`.
`project-files.ts` opts out by probing `rg --version` on PATH instead, so it is the one file
discovery path the bundle never reaches. The bundling is right; this file just declines it.

**`@`-mention should become a LIVE ripgrep query, not a pre-built list** (owner's proposal,
measured and adopted). Today `workspace:list-paths` builds up to `MENTION_PATHS_LIMIT = 4000`
paths, caches them 5 minutes, ships them to the renderer, and the composer filters client-side.
- **It already truncates on Atlarix's own repo:** 5,505 files vs a 4,000 cap, so ~1,500 files
  cannot be `@`-mentioned here *today*. That is a live bug, not a hypothetical.
- **Live query latency, bundled rg, measured on this repo (5,505 files), including process
  spawn:** `@app` 45 ms / `@test` 48 ms / `@index` 47 ms / `@workspace` 46 ms / `@a` 63 ms. With
  a ~100 ms debounce that is imperceptible, and it is *fresher* than a 5-minute cache.
- **No behaviour to preserve:** `ComposerAutocomplete` filters with plain
  `.toLowerCase().includes(q)` — substring, not fuzzy — so `--iglob "*q*"` is an exact
  equivalent. (`--iglob`, not `--glob`, to keep the case-insensitivity.)
- Payload shrinks from 4,000 paths to just the matches.

**The change.**
1. `@`-mention (`workspace:list-paths`) becomes a live `resolveRipgrepPath()` query, debounced,
   cancelling in-flight requests. Drop `MENTION_PATHS_LIMIT` as a correctness cap (keep a
   display cap on results).
2. Do the same for the other two `getProjectFiles` consumers —
   `lib/tools/workspace-file-hints.ts` (the "did you mean this path" suggestion after a failed
   read/edit) and `ipc/utils/mention_apps.ts` (scoped `@` dirs) — via one shared helper.
3. **`getProjectFiles` then has no consumers: delete `project-files.ts` entirely**, and with it
   the `fd` strategy (and its `--no-ignore-vcs`), the legacy synchronous walk, `ALWAYS_EXCLUDE`,
   `isExcludedDiscoveryRelPath` and `CDK_ASSET_HEX_SEGMENT`. `.gitignore` does the excluding,
   one engine for every file lookup in the product.
4. Keep one `--glob '!.git/**'` (or drop `--hidden`), per the measurement above — the only
   exclusion that survives, and it is derived from an observed need.
5. `file_handlers.ts:108` calls `@`-mention "gitignore-aware via getProjectFiles" — **false
   today** on the `fd` path. The comment goes with the file.

**`isExcludedDir` + the whole codebase-extractor chain is DEAD — delete it.** Correcting the
earlier note in this doc, which said it "has a different live consumer" and needed its own
decision. Traced properly, nothing reaches it:
- `ContextFilesPicker` renders only behind `showContextFilesPicker`, which defaults to `false`
  and **is never passed anywhere** (`<ChatInputControls chatId={chatId} />` is the only call
  site) → `useContextPaths` never runs → `get-context-paths` / `set-context-paths` are never
  invoked.
- The other `extractCodebaseCached` caller is `debug_handlers`' `get-chat-logs`, which has an
  `ipc_client` method (`getChatLogs`) and **no UI consumer at all**.
- Only the TYPE `CodebaseFile` is still used (type-only imports in `simple-stream-text.ts` and
  `versioned_codebase_context.ts`), which keeps no runtime alive.
- So `extractCodebaseCached` is unreachable, `isExcludedDir` has **zero live consumers**, and the
  deletable set is: `ContextFilesPicker.tsx`, `useContextPaths.ts`, the `showContextFilesPicker`
  prop, `context_paths_handlers.ts` + its two preload channels + two `ipc_client` methods, the
  `extractCodebaseCached` runtime in `utils/codebase.ts` (keep the `CodebaseFile` type), and
  `isExcludedDir` + its exclusion list in `file_utils.ts`. Vestiges of the deleted Code tab and
  the retrieval teardown — the owner's read ("we don't have a code tab, that's dead logic").
- Check `file_utils_excluded_dirs.test.ts` goes with it, and re-check `get-chat-logs` /
  `get-system-debug-info` while there: if neither has a consumer, `debug_handlers` may be
  deletable too, which is a separate call.

**One note to leave alone:** `glob.ts`'s "in-workspace files (incl. `.env`) are enumerable" means
"we apply no secret denylist of our own" — a *gitignored* `.env` is still not listed. True as
written, easy to misread.

Net effect: one engine for every file lookup, a truncation bug fixed, identical behaviour for
every user regardless of what they have installed, and several hundred lines deleted.

**Checked and CORRECT as-is — do not "fix" these.** None needs work next session; the
distinguishing test in every case is *what happens when the list is incomplete*:
- **`defaultWritablePaths`** (`lib/sandbox/wrap-command.ts`) — a curated ~18-entry home-cache
  list beside a dynamic env-var half. It is a *write* allowlist: an incomplete entry fails
  CLOSED (a denial the escalation flow then offers to grant). Making it dynamic — probing
  `$HOME` for dot-dirs — would WIDEN the sandbox. Curated is the correct posture.
- **`DANGEROUS_PATTERNS`** / **`SYSTEM_SCOPE_PATTERNS`** — UX gates, not boundaries.
  system-scope says so outright: "best-effort — the sandbox catches anything not listed here."
- **`DENIAL_PATTERNS`** — extracts a path from tool prose (a positive capability); a miss now
  degrades into `sandbox-failure-context.ts` rather than into silence.
- **Browser error capture** (`lib/browser/error-hook.ts`) — filters on the browser's own
  console `level` and HTTP status ≥ 400, never on curated message strings. Already derived.
- **`file-permission-scope.ts`** — the v14.23.0 protected-path deletion has NOT crept back; what
  remains is a set of Atlarix's own operation names, which we control.
- **`models_dev.ts` / provider dispatch** — de-hardcoded in v14.23.0; only the documented
  deliberate pins remain.
- Browser `KEY_ALIASES` / `MODIFIER_TOKENS` — a closed set from the DOM spec, not an ecosystem
  that grows.
- ~~`ALWAYS_EXCLUDE`'s non-CDK entries (`node_modules`, `dist`, `target`, `vendor`, `.venv`…)~~
  — **withdrawn.** First written up as a defensible "common build-output names" list. The
  measurement above supersedes that: `.gitignore` already excludes all of them, so the whole
  list goes with the fallback strategies. Only `.git` survives, and only because `--hidden`
  makes ripgrep list it.

## 🔜 Blocked on the owner — NOT active work

Kept for the record; none of these can be picked up in a coding session.

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI (release-infra, no cert).
  OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in, reverted; the
  flow-in-progress gate stays).
- **Billing A/B (owner-side):** confirm OpenRouter `usage.cost` includes the ~$0.005 search fee so the
  wallet debit = `ceil(cost × 1.4)`; else add a proxy surcharge in `atlarix-proxy/src/server.ts`.
- **Runtime-verify voice mic + DB shutdown-race** on a packaged build (voice confirmed working by owner
  2026-07-14; shutdown-guard committed, not stress-verified).
- ~~**Per-Core-model web-search check**~~ — **DELETED 2026-08-05.** There is no web-search API to
  verify against, so the entry described work that cannot exist.
- **Mobile emulator toolset** and **dependency deprecation triage** are each their own release; see
  their sections below and treat them as roadmap, not queue.

## 🔐 Security follow-ups (from `docs/SECURITY_REVIEW_v14.8.12.md`, owner-triaged)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF +
pro-return confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP
description wrapping + OAuth-URL validation, the **universal write-confining sandbox**
(Win AppContainer + Linux Landlock bundled), and the **system-scope approval gate** (which
also closed M1 — cwd `allowedRoots` widening is now gated on interactive approval).
**Deferred (tracked):**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (code-signing certs + `app-update.yml` for NsisUpdater; out-of-band
  signature for AppImage), not app code. Owner chose NOT to gate the public release on it.
  (Windows helper sign step is already wired — set the cert secret to enable.)
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS; they
  build (non-blocking) in the first Windows/Linux CI job — watch those `cargo build` steps and
  budget one small fix-up iteration if the Linux `landlock` 0.4 API drifted.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the
  denylist taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL
  allowlist permits a query param (current gate = flow-must-be-in-progress).
- Sandbox **read**-confinement, model-context **secret redaction**, **egress** gating, and the
  remaining Medium items (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

## Open follow-ups

- ~~**DB shutdown race — `TypeError: The database connection is not open`**~~ — **ALREADY FIXED**
  (verified v14.23.0, entry was stale). The `closing` guard exists and is wired: `beginDatabaseClosing()`
  / `isDatabaseClosing()` / `DatabaseClosingError` in `db/index.ts:690-736`, the `db` Proxy
  short-circuits on `_dbClosing`, `main.ts:1793` sets it before the `before-quit` chain, and
  `src/__tests__/db-closing-guard.test.ts` covers it.
  - ~~**Adjacent: `reset-all` leaves a closed DB handle**~~ — **ALSO ALREADY FIXED; this entry was
    stale.** It shipped in v14.23.0 as `reinitializeDatabaseAfterReset()` (`db/index.ts:706`), called
    from `app_handlers.ts:1219`, which is exactly the "re-initialize in place" option the entry was
    asking for a decision on. Struck 2026-08-05.
- **DONE in v14.8.12:** approval-wait audit (MCP auth waits now indefinite + Stop-cancellable),
  Shift+Tab global, attachment vision cold-cache, notification sound. **B4 (bg-command "done" while
  running)** resolved as model behavior — the harness DOES re-inject the exit result via auto-wake
  (`recordBackgroundCommandResult`); mitigated by the new prompt lines (ground-claims / finish-the-turn).
- **CONSIDER (evaluated → CLOSED): `browser-use`.** Not adopted — Python/Playwright (bad Electron fit),
  it's its own agent loop, and its one good idea (stable element refs) Atlarix already has via
  `browser_inspect` snapshot `ref`s. No capability gap. [[atlarix-preview-webcontentsview]]
- Small / carried: `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor
  credit (owner action; code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via read_attachment).
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase.
  Constraints: the AI SDK stack must stay on MATCHING majors — currently **`ai@6` + v3-spec
  providers** (`@ai-sdk/anthropic@3.x`, openai 3.x, openai-compatible 2.x), since v13.3
  [[atlarix-ai-sdk-version-trap]]. *(This line previously said anthropic must stay 2.x with `ai@5`,
  which described the pre-v13.3 state and inverted the actual constraint.)* Also: zod mid-v4;
  3 patch-package patches; ABI-pinned better-sqlite3/node-pty/keytar. Worklist = `npm outdated`
  (direct) + `npm audit` + own deprecated-API usage + CI action EOLs; leave pinned/transitive with
  a note.

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the existing
  `@atlarix review` GitHub bot: mention it, it picks up the task, works in a real Atlarix workspace,
  and posts the PR/result back (near-zero switching cost, big reach; how Devin / Copilot-in-Slack win).
  (b) A **shared, observable agent session** — a "war room" where several teammates watch one Atlarix
  run live, drop steering comments, approve actions, and hand off — tied to the Workforce tier. The
  chat shell is not the differentiator; the shared *agent* session is. Far-off; capture, don't build yet.

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
