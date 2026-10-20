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

**Last updated:** 2026-10-19

---

## 🔨 In flight — landed on dev, not yet released

- **Analytics: `workspace_opened` once per workspace per run** (2435dd2c), not on every read
  (it was ~113 per person per week).
- **The cost line prices Claude from the catalog.** A direct turn (your own key, Bedrock, a provider
  on the Anthropic format) is now priced from the models.dev row for that provider and model, not
  only a static table. That table had no Fable, so a Fable turn showed no cost, and it priced
  the 5.5 models at 4.x rates (Haiku 5.5 at 10x: $1/$5 for $0.10/$0.50). Haiku 5.5's
  over-100k-context price applies once a request passes 100k. Cache writes on the Anthropic format
  are priced at the 1h rate (2x input) the header is written at, not 1.25x.
  `src/lib/routing/byok-pricing.ts`, published from `src/lib/models_dev.ts`.

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
- **PostHog:** a "Weekly active users by billing" insight from `model_turn`.

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

### 4. CLI `/mcp` shows the switch, not whether the server connects

QA (15.7.0): a server that is on but fails to connect reads "✓ on" in the CLI, while the editor's
page says "Couldn't connect: Connection closed". Test on open (one connect per server), or mark a
server whose last call failed. Low.

### 5. MCP polish from the 15.7.0 app QA

- The app's MCP list doesn't update live when the CLI changes the same profile (a tab switch
  refetches). Refetch on window focus, or broadcast from the shared DB.
- The composer menu's switch takes 3–5 s with no pending state; a second click is lost.
- Automations: "Create" stays disabled until "tell the AI?" is answered, with no hint or default;
  a manual Run now logs "fired on schedule"; the tool name is free text (offer the server's tools).
- A local server with no registry icon shows a letter (Brave Search): try the npm scope's
  GitHub avatar.
- A peer message into a chat whose last turn was stopped mid-wait re-runs the stopped request
  (ai-e9's area).

### 6. Launchpad — one door left (different repo)

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

### 7. Headless `--deep-thinking` sends no level on adaptive Claude

`atlarix run --deep-thinking` ("the model's highest reasoning level") sends adaptive thinking with
no `effort` on Sonnet 5 / 5.5, Opus 4.7+, Haiku 5.5 and Fable, so the API's default applies, not
`max`. Seen on the wire 2026-10-19. Only benchmark runs use the flag (the app, CLI and editors
use `/effort`, which arrives as chosen); `--effort max` works today.

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
