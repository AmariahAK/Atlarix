# Atlarix TODO

**Current version:** 15.9.2 (2026-10-18): a leaner prompt, and browser and DeepSeek fixes. 15.9.1
brought adaptive thinking on the newest Claude models (Sonnet 5 / 5.5, Opus 4.7+, Haiku 5.5, Fable)
with `/effort`; 15.9.0 brought providers you add on the Anthropic API format (Bedrock, gateways),
Build mode's lasting prompt cache and a faster CLI start. Narrative in
[`docs/CHANGELOG.md`](./CHANGELOG.md).

**This header has been wrong before.** Update it in the same commit as the version bump, or do
not trust it.

**This file is a QUEUE.** Only work that is not yet done belongs here.

|                                     |                                             |
| ----------------------------------- | ------------------------------------------- |
| What shipped, per version           | [`docs/CHANGELOG.md`](./CHANGELOG.md)       |
| Findings that cost time to discover | [`docs/TRAPS.md`](./TRAPS.md)               |
| Designed, not scheduled             | [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) |
| Open work                           | here, and nowhere else                      |

**Last updated:** 2026-10-21

---

## 🔨 Handover 2026-10-21 — for the owner's fresh session (15.10.0 is ready on dev, NOT released)

The owner said on 2026-10-21: "no release, do everything but that". Everything below is what is left. Each item
says where it stands, exactly what to do, and how to check it worked. The team's live notes are in
`~/.atlarix-e2e/team/STATUS.md` (newest lines at the bottom) and `~/.atlarix-e2e/team/MORNING.md`.

### A. Release 15.10.0 (when you have ~1 hour)

**State.** `dev` holds all of 15.10.0. The version (package.json + lock), README "Current release: v15.10.0", the
CHANGELOG `## [15.10.0] (2026-10-21)`, the models snapshot and the extension versions are already done.
Mac QA is complete (CLI, ACP, VS Code panel, Chrome panel, analytics, multi-process stress); the full vitest (6,162)
and bun (267) suites pass, plus check:ts / check:lint / check:sandbox / check:i18n. Windows QA and app QA were still
running when this was written; their results are the last lines of STATUS.md. **Don't tag until both say PASS, or
until each FAIL in them is fixed on dev and re-checked.**
- **App QA 2026-10-21 (ai-2f): PASS** on dev d7957a29 + A10. The scratch dev app ran signed out, driving its own
  main-process handlers; app turns need a sign-in, so turn items are headless (see B). One FAIL found and fixed: A10,
  a turn refused before it starts (signed out / expired, safety filter, no workspace) was reported as
  `turn_completed{outcome:ok}` with a second end event. Fixed in 37ad4292 and re-checked in the app (4/4).
  **Windows CLI queue: NOT RUN** (the VM pass ran out of time before the Mac shutdown). The queue is in STATUS.md.
- **Windows VS Code panel + ACP queue (ai-48): NOT RUN, all 9 items.** Everything below PASSES on the Mac. The
  Windows exe + win32-arm64 VSIX from dev d7957a29 (15.10.0) were built and installed in the VM (C:\axq). Pass 4 was
  stopped by the swap rule. In pass 5 the Atlarix panel never loaded in ~35 min: Defender (MsMpEng) and Windows Update
  (TiWorker) were scanning the new files, so the webview stayed empty and no agent started. Then the wrap-up came.
  Next time: start the VM ~30 min early, or add a Defender exclusion for C:\axq (the owner's call). Scripts are in
  `~/.atlarix-e2e/team/evidence/ai48-scripts/`; the recipe is the "ai-48 WINDOWS QUEUE" block in STATUS.md.
  1. E11 take 2, panel close ends its agent by EOF and cleans temp (21252282): NOT RUN on Windows (FAILED there before the fix).
  2. E15, opening a past chat always shows it (9796cb36): NOT RUN.
  3. stop→idle in ~1.5 s while following (dd805f00, 8e408831): NOT RUN (was ~9 s on Windows before).
  4. E16, a bad cliPath is reported, no other agent started (c1368594): NOT RUN.
  5. E4 alone + named-pipe holder (71d35e44, 73540c9c): NOT RUN from the panel side (ai-2f's CLI run passed it on Windows earlier).
  6. E13 junction = one workspace from the panel (6b317bde): NOT RUN from the panel side (CLI side passed on Windows earlier).
  7. %USERPROFILE%\.atlarix untouched with no vars (fac76c9b): NOT RUN (only allowed if the VM profile is a test profile).
  8. Analytics X1–X3 + active_day (f8879884, ddef442c, dc4f32b5, 693b2e6a): NOT RUN.
  9. Re-confirm earlier Windows passes on the merged build (E10, /fork, following, approval lines + E9, E3/E8 links,
     E2, E5/E6, /compact + E7): NOT RUN (most passed on Windows on branch builds before the merge; see STATUS.md).

**Steps** (the full runbook is in memory `atlarix-release-distribution`):
1. If anything was merged after the CHANGELOG entry, add it to `docs/CHANGELOG.md` under 15.10.0, then run
   `./scripts/ci/extract-changelog.sh 15.10.0 400` and check the notes aren't empty.
2. Run locally: `npm run check:ts && npm run check:lint && npm run check:sandbox && npm run check:i18n && npm test`.
3. `git checkout main && git merge --ff-only origin/dev` (or a merge commit if main moved), then
   `git push origin main`.
4. Make the repo public (`gh repo edit AmariahAK/Atlarix --visibility public --accept-visibility-change-consequences`).
   Wait for the `release.yml` quality job on main to go green.
5. `git tag -a v15.10.0 -m "Atlarix 15.10.0" && git push origin v15.10.0`. Watch each job's steps (`gh run watch`);
   a hung step shows no log until it ends.
6. Check what users get: `gh release list --repo AmariahAK/atlarix-releases --limit 2` (not Draft, marked Latest);
   `curl -sSL https://github.com/AmariahAK/atlarix-releases/releases/latest/download/latest-mac.yml | head -1`
   shows 15.10.0; the release body is the real notes, not the ~560-char placeholder.
7. Make the repo private again (`--visibility private`) as soon as publish is green.
8. Launchpad (`atlarix-launchpad`): bump `package.json` to 15.10.0; in `public/CHANGELOG.md` bump the
   "product summary (as of …)" header and prepend a plain-language `## Atlarix 15.10.0 — …` (live sessions across
   app/CLI/editors, `/fork` everywhere, approvals that remember folder grants, compaction that works). Run
   `npm run build`, push, then curl the live site.
9. **Store uploads (by hand):** the 8 `.vsix` files at marketplace.visualstudio.com/manage/publishers/atlarix,
   then the Microsoft Store resubmission (the `unvirtualizedResources` justification is in the MSIX manifest
   comment). winget stays blocked on microsoft/winget-pkgs#446527.
10. **Note:** the release now uploads Sentry source maps. The `SENTRY_AUTH_TOKEN` repo secret is set (Sentry org
    token "atlarix-release-ci", org:ci, created 2026-10-21). If the "Upload source maps" step fails, the token or
    `SENTRY_ORG=norah-labs` / `SENTRY_PROJECT=atlarix` in release.yml is the place to look. The step skips without
    failing when there's no token.

### B. App checks that only a signed-in app window can do

The app QA on 2026-10-21 ran on the headless agent@ session (CLI/ACP), because nobody could sign the app in: the
atlarix.dev sign-in is a password plus a Turnstile captcha, which the sessions may not do. ai-2f marked those items
"headless-verified, app UI not run" in STATUS.md. To finish them yourself, launch a dev app on a scratch profile
(never your own):
`ATLARIX_USER_DATA_DIR=$HOME/.atlarix-e2e/free-agent npx electron-forge start -- --user-data-dir=$HOME/.atlarix-e2e/free-agent/electron`
from a worktree with its own `node_modules` (not a symlink). Sign in as agent@atlarix.dev (password in the
Keychain, service `atlarix-sandbox-agent`). Then check:
- **Live sessions:** start a turn in the CLI on the same scratch profile (`ATLARIX_USER_DATA_DIR=… atlarix`), open
  that session in the app. It should show "Running in the CLI" and follow the reply as it grows. Type in the app:
  the text lands in the CLI turn as a mid-turn message. Stop in the app stops the CLI turn within ~1.5 s. Then
  the reverse (CLI follows an app turn).
  *2026-10-21: the app's handlers are verified (running-elsewhere, growing revision, steer lands mid-turn, stop in
  0.57 s, 2/2); the window itself was not run. The reverse is headless only (CLI↔CLI).*
- **`/fork` in the app** (composer slash command and the session-menu "Fork"): a new tab "<title> (fork)" with
  the same messages; the original is unchanged. *2026-10-21: the app's `sessions:fork` is verified (full copy,
  source untouched, independent after). The slash command and menu were not run.*
- **Approvals (951722b7):** two edits in `src/`, approve the first with "allow edits in src/". The second card
  should clear on its own, and each operation should run once. *Headless only (CLI 2/2 + guard test).*
- **E13:** ~~open a symlinked folder in the app and its real folder in the CLI. There should be ONE workspace~~
  (verified in the app 2026-10-21), and `/undo` should work across both (*headless only*).
- ~~**L4 (46310069):** delete a custom provider from its settings page. No "Provider with ID … not found" error.~~
  Verified in the app 2026-10-21 (the delete, then the page's model list answers `[]`).
- **Polling (16a12f54):** 30 min idle shows almost no Supabase reads. The `users` row is read again after
  Upgrade/Manage billing. *2026-10-21: signed out, 16 min idle + 10 focuses = 0 requests from the app. The
  signed-in reads are headless only (CLI + guard tests that fail without the fix).*
- After the run, launch the installed /Applications/Atlarix once, so the `atlarix://` link handler points back to it.

### C. AWS / proxy

- **Shared free-tier state is ON** (`ATLARIX_SHARED_FREE_STATE=on` on Railway project Atlarix-Proxy, service
  `Atlarix`, set by the owner 2026-10-20 ~23:25 UTC). Counters live in DynamoDB `atlarix-proxy-counters`
  (eu-west-1, provisioned 20/20 = inside the always-free 25/25). **Live test passed 2026-10-20 23:34 UTC** (agent@
  zeroed, one free turn, restored to 945¢): served by MiniMax, and the bedrock day/month/user rows counted it.
  `free#pool`/`free#user` rows only appear once a turn goes past Bedrock (a cap or an outage), because the Bedrock
  path doesn't call `recordFreeUsage`. Each free call reads ~16 keys (≈8 RCU), so about 2 free calls/s fills the
  20 RCU. Past that, throttled reads fall back to per-process counts (safe, just less exact). Raise RCU only
  while it stays ≤25 total across tables (free tier).
- **Fair daily share (atlarix-proxy branch `bedrock-fair-share`, e24097c), built and tested, NOT deployed yet.**
  Each user's daily Bedrock cap is today's money (this month's paced allowance less what was spent before today)
  divided by free Auto's own active-user count (the larger of today's and this weekday last week's, from
  `loadFreeUsageState`), times free Auto's new-account multiplier, kept between $0.05 and $0.30. Before this it was
  a flat $0.30, so on a $1 day the first ~3 heavy users could use up the day. All 701 proxy tests pass. **To ship:**
  `cd ~/Documents/Github/AI/atlarix-proxy && git checkout main && git merge --ff-only bedrock-fair-share && git push origin main`.
  Railway deploys main on push. Check it's live by the commit (`railway status --json` → `meta.commitHash` =
  e24097c), not by /health.
- **Second replica: not done.** The sessions' permission check blocks production Railway changes. Per the
  proxy code, a second replica is safe from the first full UTC day after the flag went on, i.e. from
  **2026-10-21 00:00 UTC**. Before turning it on, check the Railway plan's usage page: a second replica roughly
  doubles the proxy's RAM/CPU bill. Only do it if that stays inside the plan's included usage (the rule is
  nothing that bills). How: Railway dashboard → Atlarix-Proxy → Atlarix → Settings → Replicas = 2. Check: both
  replicas serve `/health`, and a free Auto request from agent@ still answers. The CloudWatch alarm
  "atlarix-*" emails stay quiet.
- **To let a session do Railway changes without you next time,** add a Bash allow rule for
  `railway variable set` / `railway up` in Claude Code settings. The auto-mode check calls them production deploys.
- **Read the daily cost emails** (08:00 MYT, from the `atlarix-daily-digest` Lambda) for the first real free-Auto
  cost per user. The caps are $30/month, $1/day, $0.30 per user per day (proxy `bedrock-pool.ts` `BEDROCK_BUDGET`).
- **1 Nov:** the `atlarix-comp-pro` Lambda runs 00:15 UTC. It should report every user as `duplicate`, because
  pg_cron `comp-pro-allowance-monthly` grants first. Check `credit_grants` for Nov, then decide whether to
  unschedule the pg_cron job, so only one of them grants.

### D. Small leftovers

- **Editors: Windows re-checks still owed** (all PASS on the Mac). E11: closing VS Code waits for the agent, so its
  temp lease is gone and the stale dir is swept. E15: Past chats closes over a chat the CLI is running. Stop while
  following goes idle in about 1.5–3 s. E16: a missing `atlarix.cliPath` says so and starts nothing. If E11 still
  leaves the lease on Windows, have `atlarix acp` release its lease and sweep before it closes sessions
  (`src/cli/entry.mts`, acp branch). If E15 comes back, it isn't root-caused: note the exact clicks.
- **Your own profile:** a QA slip on 2026-10-21 00:41 created one empty session
  (`3d6af3f8-1349-4503-b90a-1e613485eed5`, workspace 58) in your real Atlarix data. It's harmless; delete it from
  the session list if you like.
- **PostHog alert** "Turn error rate above 15%" (dashboard 1040467) can fire on a quiet day from one failure. Raise
  it or make it relative once traffic grows.
- **CLI binary is +10 MB** (97 → 108 MB) because it now carries a positions-only source map for crash reports.
  It's a one-line revert if you'd rather keep it small.
- **Sentry:** check one new app crash links to the right file (the code mapping moved to AmariahAK/Atlarix
  2026-10-21).
- **ATLARIX-3Z** ("Maximum update depth exceeded"): see Open queue item 8. Map it the next time it fires (now
  that source maps upload).
- **Analytics on Windows: not run.** Every analytics change in 15.10.0 passed on the Mac (CLI, app, VS Code panel,
  raw ACP). The Windows pass on the VM is still to do: turn_completed fields, session_opened, VS Code's telemetry
  switch, crash-report scrubbing (Windows paths: home folder and user name).
- **Account usage counts (`client_usage_daily`) are LIVE in Supabase** (applied 2026-10-21, grants read back)
  and empty until a release carries the client (team/ai2a-telemetry). Who is active, by surface and model:
  `select * from v_latest_model_by_surface` (service role). The consent text on all four surfaces and the
  privacy page (launchpad branch `ai2a/privacy-better-together`) say it is kept with the account.
- **Telemetry on Windows: not run** for provider_type / core_plan, the BYOK turn-failure report and the usage
  flush at quit (Mac checks are in STATUS.md).

**Verified live 2026-10-19 (15.9.1, unchanged in 15.9.2), on the real Anthropic API:** Sonnet 5.5,
Opus 5.5, Haiku 5.5 and Fable 5.1 get `thinking: adaptive` + `output_config.effort` as chosen
(`low` and `max` checked); Haiku 4.5 still gets a budget; a provider on the Anthropic format
pointed at api.anthropic.com reads 24.4k of the Build prompt from cache on the second message.
Bedrock's newest-model access (AWS Sales request 2026-10-18) is no longer needed for this check.

**Known limit from 15.9.0:** Bedrock reads the request body before the key, so a bad Bedrock
token is only caught by the first message (it fails cleanly; nothing is billed). A key-prefix
hint at add time could catch typos.

## After every release — the owner, by hand

- **VS Code Marketplace: upload each `.vsix`** from the folder left on the Desktop
  (marketplace.visualstudio.com/manage/publishers/atlarix). The Marketplace is at 15.8.1; Open VSX
  is automatic (`VSCODE_AUTO_SUBMIT=true`). Move to `vsce publish --oidc` once Microsoft enables
  trusted publishing.
- **Microsoft Store resubmission** needs the `unvirtualizedResources` justification (a restricted
  capability Partner Center asks about; the text is in the MSIX manifest comment).

## Waiting on someone else

- **winget:** microsoft/winget-pkgs#446527 (AmariahAK.AtlarixCLI 15.0.0) passed validation and has
  waited for a moderator since 2026-10-04. Until it merges, every release's `update-winget` job
  fails (expected). **When it merges:** put winget back on the site (launchpad
  `src/components/CliInstall.tsx`, `src/pages/Cli.tsx` row + FAQ + meta, `public/llms.txt`).
- **ACP registry:** agentclientprotocol/registry#669 ("Add Atlarix"), open with no review since
  2026-10-10.
- **Slack Marketplace:** the listing, scopes, security answers and screenshots are filled in, and
  the full flow passed end to end on 2026-10-07. Still needed before Submit: a reviewer test
  account with credit (the owner creates it) and, optionally, a 30–90 s demo video.

## Still to verify

- **Windows:** a full turn in VS Code on Windows ARM (the VM), and the PowerShell and winget install
  paths.
- **Cloud agent on paid Core `core-2`:** never run (it was blocked by the Actions billing hold of
  2026-10-04, since cleared).

## 🔭 Open — the queue

### 1. Chrome Web Store — the dashboard copy is behind the extension

CI uploads and submits the PACKAGE (14.48.1 on 2026-09-17, 14.50.1 on 2026-09-23). Everything
below is dashboard-only, so no green run covers it. Proposed listing text is in
[`docs/CWS_LISTING.md`](./CWS_LISTING.md); run `node scripts/cws-copy-check.mjs` before pasting.

- [ ] **Paste into the dashboard:** `cws/DESCRIPTION.txt` and `cws/TEST-INSTRUCTIONS.txt` (rewritten
      2026-10-21 to match the listing and the paid-only extension; `cws-copy-check` passes), and the
      `debugger` and `scripting` justifications below.
- [ ] **The `debugger` and `scripting` justifications.**
      `cws/PRIVACY-FORM.md` is current as of v14.52.0 (stays attached to agent tabs for console,
      network, on-demand response bodies and screenshots; injects the packaged axe-core for the
      visual report). The dashboard still carries the older text — an inaccurate disclosure is
      what pulls a live item.
- [ ] Keep the review account funded and its credentials in the dashboard, not the file. **A
      reviewer who hits a zero balance sees an extension that does not work, and the rejection
      will not mention money.**
- [ ] Screenshots: none of `cws/screenshot-*.png` shows Atlarix Auto, the agent acting on a page,
      or a screenshot in the conversation.

### 2. Per-session tab groups (extension, optional)

`tabs/group.ts` keys `windowId → groupId` under `atlarix.tabGroups.v1`; one group per chat
session makes the key `${sid}:${windowId}`, needing `v2` plus a migration that maps old entries
to a reserved `"panel"` session. Do not silently reinterpret v1 entries. The single per-window
group is what ships today.

### 3. The win32 TypeScript 7 platform binary is unexercised in CI

Linux is proven: the `quality` job runs `npm run check:ts` on `ubuntu-latest`. On Windows,
`npm ci` installs cleanly on `windows-latest`, but no Windows job runs `tsc`, so the win32
binary has never actually been executed there.

### 5. MCP polish from the 15.7.0 app QA

The rest of this item shipped on dev 2026-10-21 (focus refetch, composer switch, tool picker, npm-scope
icon). Left as they are on purpose: "tell the AI?" keeps no default (it decides whether an automation
spends tokens, 774fdfd0; Create already says why it is off), and "Run now" already says it was started
by hand (2026-10-14).

- A peer message into a chat whose last turn was stopped mid-wait re-runs the stopped request
  (ai-e9's area).

### 6. Launchpad — one door left (different repo)

`atlarix-launchpad`, not this one. One entity behind three doors on one domain — desktop app,
Chrome extension, PR reviewer — because LLMs and listicles answer by CATEGORY. `/`, `/reviewer`
and `/extension` exist with their JSON-LD (`reviewerApplication()`, `faqPage()` on /reviewer and
/pricing, and on blog posts that set `faq`).

`/better-together` is written (launchpad branch `ai2a/privacy-better-together`) on what is true
today: one account and balance, a reviewer that never runs code and sees only the diff, and the
cloud agent's pull requests reviewed the same way. Still missing:

- **A real app→Reviewer context handoff** (e.g. Reviewer also reads `.atlarix/atlarix.md`): a
  product change in atlarix-reviewer, the owner's call. Nothing passes app context to a review
  today, so no page may claim it.

**Do not expect this to move the numbers.** Per the 2026-09-18 baseline, 89% of clicks are the
literal word "atlarix" and /pricing had never been crawled: the bottleneck is AUTHORITY, not
markup. The movement comes from third-party pages (the CWS listing, the GitHub Marketplace
listing, launches).

### 8. "Maximum update depth exceeded" in the window, once (Sentry ATLARIX-3Z)

Six events on 2026-10-08, all from 15.1.0 on one Mac (the owner's, by the device); none since,
on any release. No component stack or breadcrumbs (the window's Sentry sends neither), and no
source maps then. The minified chain: React's root event listener → an `onChange` → a jotai
atom write in `chatAtoms` → the loop. So an input's change handler writes a chat atom whose
subscribers write back. Not mapped on purpose: builds now carry hidden source maps (1ef9c8dd),
so a recurrence resolves straight from Sentry. If it recurs, resolve its frames and fix there;
to map the old one, build tag v15.1.0 with `build.sourcemap: "hidden"` and resolve
`index-DiRzEsx2.js` 751:43960 and 792:92224.

---

## ⚠️ Known and NOT fixed — deliberately, with reasons

- **The packaged app does not exit after `--self-test`. ROOT CAUSE UNIDENTIFIED.** It prints
  `PASSED` and keeps running; a second process boots the app for real, which is only possible
  with `IS_SELF_TEST` false. Seen on macOS arm64 and Windows, intermittently. Mitigated in
  v14.36.0: the verdict comes from the probe REPORT rather than from process termination. **Next
  step is one observation, not more code reading**: a Windows machine, `atlarix.exe --self-test`
  from a terminal, and Process Explorer to see what the second process's parent is.
- **`withLock` serialises TWO callers, not N.** `src/ipc/utils/lock_utils.ts` awaits only the lock
  it observed, so with three contenders B and C both wake and both acquire. Plan writes already
  use their own FIFO chain (`withPlanArtifactLock`). Changing shared locking semantics deserves
  its own pass.
- **8 conditional-hook violations, visible but not blocking.** `useStreamChat.ts` ×4,
  `SubAgentRunCard.tsx` ×2, `useWorkspacePlanPanel.ts` and `RightPanel.tsx` ×1. They work only
  because the condition is stable for a component's lifetime. **`useStreamChat` is the risky
  one** — changing its hook ORDER can break streaming. `react-hooks/rules-of-hooks` is `warn`;
  raise to `error` once these are gone (the ninth warning, `useSafeStorageProvider` in
  `src/cli/entry.mts`, is not a React hook: rename it first). `react-hooks/exhaustive-deps` (off)
  is the next rule worth turning on.
- **Local packaged builds report `environment=production` to Sentry — SETTLED, keep.** Some bugs
  are only findable through Sentry, and separating the environment would put exactly those runs
  where nobody looks. **Never read production alert VOLUME as a user-impact signal without
  checking the source.**
- **`ai@7`'s `instructions` placement is the aligned end state, not done.** `role:"system"` inside
  `messages` stays so the prompt-cache layout remains byte-identical and measurable. Moving it
  needs its own commit and its own `[prompt-cache] read=` measurement.

---

## 🔐 Security follow-ups — owner-triaged, deferred

- **Native sandbox validation in CI.** `npm run check:sandbox` cross-target type-checks all four
  (helper, target) pairs, but that does not substitute for running them on the real OS.
- **Windows code-signing cert.** The sign steps are wired for the sandbox helper and the bridge
  relay; the secret is not set. The only real fix for the C6 residual on direct-download Windows.
- **Unattended read-only allowlist-flip.** The denylist taxonomy is done; the flip needs
  per-automation design so it does not break legitimate builds and tests.
- Sandbox **read**-confinement (Windows blocker), **egress** gating, and the remaining Mediums:
  env-var key inheritance, secret-basename list, cross-workspace file scope, plaintext-keychain
  fallback.
- **OAuth `state` nonce / PKCE stays NOT DOING** on the desktop. Attempted v14.12.0, broke
  sign-in, reverted. Revisiting needs confirmation that the Supabase redirect-URL allowlist
  permits a query param.

---

## 🔜 Blocked on the owner — not active work

- **GitHub Marketplace — waiting on GitHub.** The `atlarix-reviewer` listing showed "Pending for
  publish" with every checklist item complete, three weeks after the 2026-08-27 submission.
  GitHub Support has no Marketplace category any more, so the chase went to
  <https://github.com/orgs/community/discussions/208022> on 2026-09-16. **Do not touch "Withdraw
  request"** — it returns the listing to the back of the queue.
- **Delete the "Atlarix Reviewer" LemonSqueezy product** (`1317705`, variant `2060123`). Zero
  subscriptions ever, and no code references the variant; Reviewer is part of Pro now.
- **One account holds Pro it never paid for** — `d22ee539…`, `plan = pro` with no subscription and
  no `credit_grants` row, from the users-INSERT escalation closed on 2026-08-28. It draws no
  credit and has never used Reviewer. Reset to `free` when convenient.

---

## 🧭 Designed — awaiting a session

The reasoning lives in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md); these are the pointers.

- **Core under concurrency.** Mostly solved: `balance-cache.ts` keys on `userId` and holds a
  per-call reservation, Postgres stays the sole authority, `spend_from_wallet` takes `FOR UPDATE`,
  and the reviewer's cost now comes from the proxy (`X-Atlarix-Cost-Cents`, summed by
  `createCostMeter`) rather than a ledger window. **One residual:** multi-replica overspend is
  bounded at roughly one reserve per replica per user; not worth fixing until a second replica
  exists.
- **DECIDED 2026-10-04: paid Auto picks the model by MODE, not by a learned router**, and there is
  NO automatic escalation; a retry ("Try with a stronger model") stays the user's choice. Live in
  core-models.json (atlarix-releases 43cd1cb); since 15.8.0 `/effort` low / medium / max picks the
  lane (low drops to Luna high), and at medium → max: explore/build/debug GLM high →
  Sol high; plan/review Sol high → Astra high; sub-agents Luna high → GLM high; titles Luna none,
  compaction/summary Luna low; images climb from GLM to Sol automatically. The router options
  below are LATER, and only with outcome data.
- **Voice on Auto: not offered (feature, not a bug).** Checked 2026-10-04: Auto doesn't declare
  audio input (`detectAudioCapability` is false for `compass:atlarix/auto`), so the mic is hidden
  on Auto unless a BYOK speech provider is set; the `transcribe` lane in core-models.json is
  unused, and Luna would reject audio anyway (`Audio input is not available.`). To offer it: route
  `purpose: transcribe` in the proxy to OpenAI's transcription endpoint, meter it, then declare
  audio for Auto.
- **Paid Auto: a router that picks the lane WITHIN a mode** (owner, 2026-10-04). Today the lane
  table picks by mode/purpose/image/escalation; the saving is "this build step is easy → GLM/Luna,
  this one is hard → Sol/Astra". Options, best fit first:
  1. **A router trained on our own traffic** (RouteLLM, LMSYS): a tiny classifier learns "will the
     cheap model do this well enough?" from real outcomes. The proxy already logs every paid Auto
     call; add whether each succeeded (user kept going, no retry, no model switch, tools didn't
     fail) and that is training data no outside model has.
  2. **Rules on signals we already have:** tool failures in the turn, retries/escalation, diff or
     context size, files involved, the last cheap step failing ("GLM until two failures, then
     Sol"). Much of the benefit, zero risk; `escalate` already does a little of this.
  3. **An off-the-shelf decision model** (mini-Jev, NotDiamond): works on day one, trained on
     someone else's tasks.
  4. **Luna as the router:** a full model call on every step; slower, usually not worth it.
  5. **A personal learner in Atlarix** (owner's preferred direction): a contextual bandit of a
     few KB in the app/CLI's shared DB, learning per person and per project which lane and effort
     work. It looks at mode, project traits, step size, tool failures and past outcomes, and is
     rewarded by the outcome signals minus cost. A "cheaper ↔ smarter" dial sets the cost weight.
     It stays on-device, sends Auto a hint, and the proxy still enforces billing and the allowed
     lanes. It starts from the global table, or 1, as its prior. It never explores downward on
     plan/review steps, and says why it picked a lane. The cloud agent uses stats synced to the
     account.

  Whatever ships runs in `shadow` first (`core-models.json` `auto.paid.mode`): log its pick next
  to the table's, compare cost and outcomes, then let it decide. Order: outcome logging (every
  option needs it) → 2 → 5 in shadow → 5 deciding; 1 as the global prior once data exists.

**Anything here becoming real needs a MEASUREMENT first.** 704 Supabase requests/hour once looked
like website traffic and was a 5-second poll of our own.

---

## 🔭 Long-term — not soon

- **`review-posted` automation event.** A reviewer posts a review → the trigger fires → Atlarix
  reads the comments via the GitHub API → the agent fixes them → pushes. Works with ANY reviewer
  (Atlarix Reviewer, CodeRabbit, Bugbot, a human), through GitHub's public review API rather than
  a private channel. **The shape it was written against is gone:** the GitHub trigger
  (`GithubTriggerEventSchema`, `pollers/github.ts`) was retired in v14.41.0 in favour of
  host-agnostic MCP and schedule triggers (see the note in `src/lib/automations/types.ts`), so
  this needs a design that fits those rather than a new vendor-specific poller.
- **Collaborative agent (the "team + @atlarix" direction).** _Its first piece — `@atlarix` in
  Slack, as the front door to the cloud agent — is built (see Next up and DESIGN_NOTES). What
  follows is the rest._ NOT a Slack/Discord clone — real-time
  chat is a money pit and teams already have it. Two pieces instead: (a) **`@atlarix` bots inside
  the tools teams already use** — Slack, Discord, GitHub issues — the shape Atlarix Reviewer
  already takes (its spec is `docs/atlarix-pr-bot-spec.md` in the `atlarix-reviewer` repo); and
  (b) a **shared, observable agent session** where teammates watch one run live, steer, approve
  and hand off. The shared _agent_ session is the differentiator, not the chat shell. Capture,
  don't build yet.
