# Atlarix TODO

**Current version:** 15.10.0 (2026-10-21): project memory that recalls the right notes, live sessions and
`/fork` across app, CLI and editors, approvals that remember folder rules, compaction that works, a chat history
that stays in the prompt cache, and per-surface usage data. Narrative in [`docs/CHANGELOG.md`](./CHANGELOG.md).

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

## 🔨 Handover 2026-10-21 (night) — 15.10.0 released by ai-d1; what is left

The owner approved the full release on 2026-10-21. Team notes: `~/.atlarix-e2e/team/STATUS.md` (newest at the
bottom) and `~/.atlarix-e2e/team/MORNING.md` (the owner's list).

### A. After 15.10.0

- **QA gate that passed:** every Mac batch (CLI, raw ACP, TUI; ai-bc) and Windows phase 1 on RC 181aadd4 (CLI
  queue, approvals, E4 leases, A8 init lock, E13 junction, memory on a C:\ workspace, HOME leak, /mcp stderr, T1,
  cancelled stop). 78c44b20 (Bedrock key hint) is Mac-only.
- **Not re-run on the merged build (owner: skip for this tag), passed on branch builds:** the Windows VS Code panel
  GUI items — E15, stop→idle while following, E16, analytics X1–X3, and the re-confirms. **E11 (closing VS Code
  ends the agent and frees its lease) has NEVER passed on Windows**; it needs the panel's CDP driver, which is
  gone from disk (`~/.atlarix-e2e/team/evidence/ai48-scripts/` keeps only the VM-side helpers). Rebuild the driver,
  then run E11 first.
- **Windows CLI start takes ~64 s** in the VM: Defender re-scans the 133 MB x64 exe on every start (MsMpEng
  1,300+ CPU-s). Check on a real Windows machine; if it holds, look at signing the exe (the Windows code-signing
  cert in Security follow-ups) or a smaller binary.
- **Windows ACP folder option reads `src/`** with a forward slash. Cosmetic.
- **`atlarix --version` unpacks the skills cache.** It shouldn't need to.
- **Store uploads by hand:** the 8 `.vsix` at marketplace.visualstudio.com/manage/publishers/atlarix, then the
  Microsoft Store resubmission (`unvirtualizedResources` justification in the MSIX manifest comment). winget is
  still blocked on microsoft/winget-pkgs#446527.
- **Owner decision:** should a scratch-profile CLI ever install Atlarix's Chrome native host into the real
  Chrome folders? It can today (pre-existing).
- **Memory, seen in QA:** weaker models (GLM-4.7-Flash) ignore a "save a note" ask sometimes; qwen3-coder
  ignored it once. Haiku is fine.

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
- **Fair daily share + paid-Auto Bedrock tail: on proxy main (57c91fb), NOT deployed** — Railway's platform outage
  ("builds paused", from 2026-10-21 11:33 UTC) blocked every deploy. When it recovers, if `/health` doesn't show
  `"commit":"57c91fb"` within ~10 min, run `railway up --service Atlarix --detach` in atlarix-proxy. The fair share
  was built as branch `bedrock-fair-share` (e24097c):
  Each user's daily Bedrock cap is today's money (this month's paced allowance less what was spent before today)
  divided by free Auto's own active-user count (the larger of today's and this weekday last week's, from
  `loadFreeUsageState`), times free Auto's new-account multiplier, kept between $0.05 and $0.30. Before this it was
  a flat $0.30, so on a $1 day the first ~3 heavy users could use up the day. The paid-Auto tail
  (`auto.paid.tail` in core-models.json, live since atlarix-releases fd126ce) adds MiniMax M2.5 → Kimi K2.5 after
  low's own models and Kimi K3 (`us.` profile) after medium's; kept out of `levels` so shipped apps keep their 1M
  Auto window. 708 proxy tests pass. Until the deploy, old proxies ignore the tail, and the app's memory recall
  (`purpose: memory`) bills on the build lane for paid Auto.
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
