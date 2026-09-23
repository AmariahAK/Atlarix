# Atlarix TODO

**Current version:** 14.50.1 in `package.json`. v14.50.0 was the last desktop tag (2026-09-22);
14.50.1 went out as the extension-only tag `ext-v14.50.1` (2026-09-23), carrying the extension's
free Atlarix Auto, screenshots and new-session-on-open. Desktop work on `dev` not yet in a
desktop release: Atlarix Auto (free, then paid routing), the Browser panel's retirement, the
context-meter fix and the voice follow-ups.
Narrative in [`docs/CHANGELOG.md`](./CHANGELOG.md).

**This header has been wrong before.** Update it in the same commit as the version bump, or do
not trust it.

**This file is a QUEUE.** Only work that is not yet done belongs here.

|                                     |                                             |
| ----------------------------------- | ------------------------------------------- |
| What shipped, per version           | [`docs/CHANGELOG.md`](./CHANGELOG.md)       |
| Findings that cost time to discover | [`docs/TRAPS.md`](./TRAPS.md)               |
| Designed, not scheduled             | [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) |
| Open work                           | here, and nowhere else                      |

**Last updated:** 2026-09-23

---

## 🔭 Open — the queue

### 1. Chrome Web Store — the dashboard copy is behind the extension

CI uploads and submits the PACKAGE (14.48.1 on 2026-09-17, 14.50.1 on 2026-09-23). Everything
below is dashboard-only, so no green run covers it. Proposed listing text is in
[`docs/CWS_LISTING.md`](./CWS_LISTING.md); run `node scripts/cws-copy-check.mjs` before pasting.

- [ ] **Fix the `debugger` justification — it is now inaccurate.** `cws/PRIVACY-FORM.md` says
      `debugger` is attached only for the duration of an action and never used to read network
      traffic. Since v14.48.0 it stays attached to the agent's own tabs to capture console and
      network activity (`page/cdp-capture.ts`), and since 2026-09-23 it also takes screenshots
      (`Page.captureScreenshot`). An inaccurate disclosure is what pulls a live item.
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

### 4. Launchpad — the three doors are two-thirds built (different repo)

`atlarix-launchpad`, not this one. One entity behind three doors on one domain — desktop app,
Chrome extension, PR reviewer — because LLMs and listicles answer by CATEGORY. Routes `/`,
`/reviewer` and `/extension` exist and are statically generated; `structured-data.ts` has
`desktopApplication()`, `browserExtension()` (with `isPartOf` to the app), `faqPage()` and
`graph()`.

Still missing:

- **`/reviewer` emits no JSON-LD.** `Reviewer.tsx` passes no `jsonLd` while `Index.tsx` and
  `Extension.tsx` do. Needs a `reviewerApplication()` following `browserExtension()`'s
  `isPartOf` pattern (schema.org has no "code review" category, so it is
  `DeveloperApplication` again).
- **`faqPage()` has no caller.** `PricingPage.tsx` hand-rolls its own FAQ JSON-LD and injects it
  with raw `dangerouslySetInnerHTML`, bypassing `graph()`. Route it through `faqPage()` +
  `usePageMeta`, then add FAQ blocks to `/reviewer` and `/extension`.
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
- **Core under concurrency.** Mostly solved — `balance-cache.ts` keys on `userId` and holds a
  per-call reservation, Postgres stays the sole authority, and `spend_from_wallet` takes
  `FOR UPDATE`. **Two residuals:** multi-replica overspend is bounded at roughly one reserve per
  replica per user and is not worth fixing until a second replica exists; but **the reviewer's
  cost attribution BREAKS on a second replica** — `ReviewQueue.spendSince` reconstructs cost from
  a ledger window that is exact only because one replica is strictly sequential. The fix is for
  the proxy to return the debited amount on the response. **Do this BEFORE scaling the reviewer.**
- **Launchpad Turnstile — deferred with the reason measured**, not merely postponed.

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
- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat is a money pit and teams already have it. Two pieces instead: (a) **`@atlarix` bots inside
  the tools teams already use** — Slack, Discord, GitHub issues — the shape Atlarix Reviewer
  already takes (its spec is `docs/atlarix-pr-bot-spec.md` in the `atlarix-reviewer` repo); and
  (b) a **shared, observable agent session** where teammates watch one run live, steer, approve
  and hand off. The shared _agent_ session is the differentiator, not the chat shell. Capture,
  don't build yet.
