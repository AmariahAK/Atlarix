# Atlarix TODO

**Current version:** 15.7.0 (2026-10-14): MCP servers from the official MCP Registry on every
surface (five Verified, paste anything, web servers on the account, local ones per folder), the
agent suggests and connects the server a task needs, every server shows its logo, and revert keeps
work done after the turn. Narrative in [`docs/CHANGELOG.md`](./CHANGELOG.md).

**This header has been wrong before.** Update it in the same commit as the version bump, or do
not trust it.

**This file is a QUEUE.** Only work that is not yet done belongs here.

|                                     |                                             |
| ----------------------------------- | ------------------------------------------- |
| What shipped, per version           | [`docs/CHANGELOG.md`](./CHANGELOG.md)       |
| Findings that cost time to discover | [`docs/TRAPS.md`](./TRAPS.md)               |
| Designed, not scheduled             | [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) |
| Open work                           | here, and nowhere else                      |

**Last updated:** 2026-10-08

---

## Next up — releasing 15.4.0

- **Owner's go-ahead** to push `v15.4` (Atlarix and atlarix-launchpad) and tag v15.4.0.
- **VS Code Marketplace: upload by hand.** After the release, upload each `atlarix-<platform>-15.4.0.vsix`
  from the release at marketplace.visualstudio.com/manage/publishers/atlarix (no Azure DevOps token;
  move to `vsce publish --oidc` once Microsoft enables trusted publishing — the email is sent).
- **Open VSX:** `gh variable set VSCODE_AUTO_SUBMIT --body true` before tagging, or `npx ovsx publish`
  each VSIX by hand. `OVSX_PAT` is set.
- **ACP registry PR** (agentclientprotocol/registry): `atlarix/agent.json` (npx `atlarix@15.4.0`,
  args `["acp"]`) + `icon.svg` = `assets/rix/rix-glyph.svg`; run `verify_agents.py --auth-check`.
  Public, so the owner's go-ahead first.
- **Windows full turn in the VM:** the VM's desktop app is 14.52, so the CLI (correctly) refuses its
  database. Update the app there, then run a turn in VS Code on Windows ARM.
- The launchpad changelog for 15.4.0 is its own rewrite (never a copy of this one).

## Next up — after 15.0.1

- **Slack Marketplace submission.** Listing (six live screenshots), scope reasons, security and
  compliance, and testing instructions are filled in. Still needed before Submit: a reviewer
  test account with credit (Slack is paid; the owner creates it) and a demo video link
  showing install → connect → task → PR → Approve & merge. Review is about 10 days
  preliminary plus about 10 weeks functional.
- **Slack launch (owner: "another day").** To submit: (1) a reviewer test account with credit,
  created by the owner; its details go in step 4 "Test Account Details"; (2) a demo video link
  (install → Connect Atlarix → task → PR → Approve & merge), recorded live; host it unlisted
  on YouTube or on atlarix.dev; (3) step 5 automated checks, accept the Marketplace
  agreement, Submit. The /slack page, guide, privacy section and listing are already live.
  atlarix-cloud-test is private again: make it public only while recording (its Actions are
  billing-blocked when private).
- **Sessions that talk to each other (owner, 2026-10-06), in the CLI and the desktop app.** Like
  Claude Code's cross-session messaging: one Atlarix session can list the other sessions running
  on this machine (CLI or app, any workspace) and send one a message or a handoff with context,
  for example "here's the brief, do the video" or "found 3 bugs, here's the repro". The receiver
  gets it in its own conversation as a message from that session, not as the user's words.
  - **List:** running sessions, with a name, workspace, surface (CLI/app) and whether each is busy.
  - **Send:** text plus optional attached context (files, a summary of this session). It is
    delivered at the receiver's next step, the way a steer is.
  - **Reply:** the receiver can answer back to the sender's address.
  - **Rules:**
    - A peer's message is a teammate's request, never the user's approval: it can't approve a
      pending permission or change settings, and the UI says who sent it.
    - Local only: a socket in the user data directory, nothing over the network.
  - **Where it plugs in:** the existing mid-turn steer queue (`chat:interject`) is the delivery
    path. The CLI and the app already share sessions and the DB; what's missing is a registry of
    live sessions and an address per session.
- **CLI: "AI SDK Warning … temperature is not supported" toast.** Atlarix Auto sends a
  temperature to OpenAI reasoning models (seen with gpt-6-luna); the SDK drops it and warns,
  and the CLI's warning toast shows it. Don't send temperature to reasoning models (or drop
  the SDK's "unsupported" warnings from the toast; they also land in ~/.atlarix/logs/cli.log).
- **Slack polish seen in the live run:** after Approve/Close the old message keeps its
  buttons (update it with chat.update); "the agent stopped before finishing" was shown for a
  CLI install failure (say what failed).

## Next up — finishing 15.0.0

Deployed 2026-10-03, before the tag: Relics (worker, R2, function), device sign-in, every
migration, the proxy (cloud runs), the reviewer on cloud.atlarix.dev with the "Atlarix Cloud
Agent" GitHub App (`atlarix-cloud-agent`, id 5176493), `AmariahAK/atlarix-agent-action` (v1),
and the Slack app (A0C6B1SKTJ7, home workspace Norah Labs, public distribution on).

1. **npm:** done. All 8 packages publish from CI by OIDC (`atlarix` via headless.yml, the 7
   platform packages via release.yml, trusted 2026-10-04).
2. **winget:** first submission is microsoft/winget-pkgs#446527 (CLA signed; tags fixed and a long
   description added 2026-10-04), waiting on moderation. **When it merges:** put winget back on the
   site (launchpad `src/components/CliInstall.tsx`, `src/pages/Cli.tsx` row + FAQ + meta, `public/llms.txt`). CI
   runs `komac update` from the next release on.
0. **GitHub Actions is blocked by billing (2026-10-04, ~14:17 UTC):** every job on the account
   fails with "recent account payments have failed or your spending limit needs to be increased"
   — Atlarix CI (90d0ee64 never ran) and the cloud-agent test repo alike. Owner: GitHub → Settings
   → Billing and plans. Then re-run CI for 90d0ee64 and the `core-2` cloud run (job created
   2026-10-04, refused before claim; it is swept to failed).
3. **End to end on a test repository:** own key DONE 2026-10-04 on AmariahAK/atlarix-cloud-test
   (DeepSeek: install → setup PR → /cloud → PR #2 → Approve merged; `byok_provider/model`
   recorded, 0 spend, PostHog `cloud_job_finished` billing=byok). Paid Auto DONE the same day
   (PR #3: 7¢ in 5 ledger rows = `spent_cents`, taken from the Pro allowance first, PostHog
   billing=core). Still to run: `core-2` (blocked by Actions billing, item 0), then Slack: the app is not installed
   in any workspace yet (`slack_installs` empty) — Add to Slack from atlarix.dev/cloud (owner's
   OAuth consent), DM the bot, link the account, send `[byok] owner/repo: task`.
4. **Install paths:** curl, brew, npm checked at 15.0.0 (2026-10-04); PowerShell and winget
   on Windows still to check.
5. **PostHog:** an insight "Weekly active users by billing" from `model_turn`, once events arrive.
6. **Windows code signing:** buy an Authenticode certificate; the job signs as soon as
   `SM_CODE_SIGNING_CERT_SHA1_HASH` exists.
7. **Both Atlarix processes' Chrome tab groups** need the new extension (CWS review of this
   release); until then they share one group.

## Next up — after v14.52.3

- **MS Store submission needs the `unvirtualizedResources` justification.** The MSIX manifest now
  declares it (with `desktop6:RegistryWriteVirtualization` disabled) so the bridge's registry key
  reaches the real HKCU. It is a restricted capability: Partner Center asks why. Text is in the
  manifest comment.
- **Launchpad homepage video cards describe the retired in-app browser**
  (`src/components/marketing/VideoWalkthroughs.tsx`: "A full browser inside the app…"). The copy
  can change; the video itself shows the old browser — needs a decision on re-recording.

## 🔭 Open — the queue

### 1. Chrome Web Store — the dashboard copy is behind the extension

CI uploads and submits the PACKAGE (14.48.1 on 2026-09-17, 14.50.1 on 2026-09-23). Everything
below is dashboard-only, so no green run covers it. Proposed listing text is in
[`docs/CWS_LISTING.md`](./CWS_LISTING.md); run `node scripts/cws-copy-check.mjs` before pasting.

- [ ] **Paste the `debugger` and `scripting` justifications into the dashboard.**
      `cws/PRIVACY-FORM.md` is current as of v14.52.0 (stays attached to agent tabs for console,
      network, on-demand response bodies and screenshots; injects the packaged axe-core for the
      visual report). The dashboard still carries the older text — an inaccurate disclosure is
      what pulls a live item.
- [ ] **Rewrite `cws/DESCRIPTION.txt`** to match `docs/CWS_LISTING.md`. "What it costs" still
      says Core is pay-as-you-go only, with no word of free Atlarix Auto, and "the contents of
      pages Atlarix reads never leave your machine" contradicts the data disclosure (page text
      goes to the model; it is only kept out of sync).
- [ ] **Rewrite `cws/TEST-INSTRUCTIONS.txt`.** It says "the extension holds no host access at
      install" (false since 2026-09-17) and that a new account "will refuse to start a turn"
      (false since free Auto: a new account gets the one-time consent card instead). The
      reviewer flow should cover that consent.
- [ ] **Revisit `cws/PRIVACY-FORM.md` → Distribution → Payments.** Its reasoning ("a new
      account's balance is ZERO and its first message returns a 402") predates free Auto.
      "Contains in-app purchases" is probably still right (Pro and credit), but the stated
      reason is not.
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

### 4. Launchpad — one door left (different repo)

`atlarix-launchpad`, not this one. One entity behind three doors on one domain — desktop app,
Chrome extension, PR reviewer — because LLMs and listicles answer by CATEGORY. `/`, `/reviewer`
and `/extension` exist with their JSON-LD (`reviewerApplication()`, `faqPage()` on /reviewer and
/pricing, and on blog posts that set `faq`).

Still missing:

- **A "better together" page**: the workstation hands context to the Reviewer, which judges it
  independently. A new route takes `{ path, element, entry }`; add it to the sitemap's `PAGES`
  map for `lastmod` and to `RULES` for priority.

**Do not expect this to move the numbers.** Per the 2026-09-18 baseline, 89% of clicks are the
literal word "atlarix" and /pricing had never been crawled: the bottleneck is AUTHORITY, not
markup. The movement comes from third-party pages (the CWS listing, the GitHub Marketplace
listing, launches).

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
- **`useAuth` is an UNSHARED hook with ~21 consumers**, each running its own `checkSession()`.
  Guard in the IPC handler, never in the hook. The sign-out half is scoped:
  `SubscriptionManager.signOut()` does not broadcast `auth:resolved`, so a second window keeps a
  stale session. Fix is one call plus clearing `user`/`status` on a null user — do it with the
  rest of the unshared-hook work.
- **8 conditional-hook violations, visible but not blocking.** `useStreamChat.ts` ×4,
  `SubAgentRunCard.tsx` ×2, `useWorkspacePlanPanel.ts` and `RightPanel.tsx` ×1. They work only
  because the condition is stable for a component's lifetime. **`useStreamChat` is the risky
  one** — changing its hook ORDER can break streaming. `react-hooks/rules-of-hooks` is `warn`;
  raise to `error` once these are gone. `react-hooks/exhaustive-deps` (off) is the next rule
  worth turning on.
- **Local packaged builds report `environment=production` to Sentry — SETTLED, keep.** Some bugs
  are only findable through Sentry, and separating the environment would put exactly those runs
  where nobody looks. **Never read production alert VOLUME as a user-impact signal without
  checking the source.**
- **`ai@7`'s `instructions` placement is the aligned end state, not done.** `role:"system"` inside
  `messages` stays so the prompt-cache layout remains byte-identical and measurable. Moving it
  needs its own commit and its own `[prompt-cache] read=` measurement.

---

## 🔐 Security follow-ups — owner-triaged, deferred

- **Project-wide `TRUNCATE` revoke on the older tables — OWNER'S CALL, still open.** Supabase grants
  all of `arwdDxtm` on every new `public` table to `anon`, `authenticated` and `service_role`, and
  **TRUNCATE IS NOT FILTERED BY ROW SECURITY**. Proved on the live database 2026-09-14 inside a
  rollback. Every table created since carries the revoke; `users`, `credit_wallet`,
  `credit_grants` and `conversations` do not. Not currently reachable (PostgREST has no TRUNCATE
  verb) but one bug away from total data loss.
- **`MAINTAIN` is also still granted** on those tables. Milder — it reads and writes no data —
  but the house rule is "no privilege we did not intend". Fold it into the same migration.
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

- **The CLI.** TUI + loopback-PKCE auth + billing over the headless binary that already ships.
  The ledger already accepts a `cli` source.
- **Core under concurrency.** (The reviewer cost-attribution residual below is FIXED: the proxy
  returns `X-Atlarix-Cost-Cents` and `createCostMeter` sums it.) Mostly solved — `balance-cache.ts` keys on `userId` and holds a
  per-call reservation, Postgres stays the sole authority, and `spend_from_wallet` takes
  `FOR UPDATE`. **Two residuals:** multi-replica overspend is bounded at roughly one reserve per
  replica per user and is not worth fixing until a second replica exists; but **the reviewer's
  cost attribution BREAKS on a second replica** — `ReviewQueue.spendSince` reconstructs cost from
  a ledger window that is exact only because one replica is strictly sequential. The fix is for
  the proxy to return the debited amount on the response. **Do this BEFORE scaling the reviewer.**
- **DECIDED 2026-10-04: paid Auto picks the model by MODE, not by a learned router**, and there is
  NO automatic escalation; a retry ("Try with a stronger model") stays the user's choice. Live in
  core-models.json (atlarix-releases 43cd1cb), thinking off → on: explore/build/debug GLM high →
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
