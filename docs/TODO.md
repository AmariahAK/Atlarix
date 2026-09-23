# Atlarix TODO

**Current version:** 14.51.0, released 2026-09-23 (desktop + extension in one `v*` tag): one
Atlarix Auto for everyone, the Browser panel retired, voice and extension follow-ups.
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

## Next up — reported by the owner 2026-09-23

- **Session titles: adopt the reference tools' universal pattern (NOT a small `maxOutputTokens`).**
  Symptom: DeepSeek V4 Pro (BYOK) titled "hey how are you? could u tell me about yourself?" as
  "Hey! I'm doing well, thanks for asking. 😊 I'm **DeepSeek V4 Pro**, running ins…" — the model
  ANSWERED the transcript and `resolveGeneratedChatTitle` kept its first 80 chars. The 30-token cap
  (`maxTokens` in `src/utils/chat_naming.ts:241`) is ignored by ai@6, but the owner's call is right:
  do NOT "fix" it with a tiny `maxOutputTokens` — no reference tool does that, and a reasoning model
  can spend the whole budget thinking and return empty. Auto/Core naming works today; keep it
  working. Not a 14.51.0 regression; the main turn is unaffected (verified end-to-end in the log).

  **What the references do (researched 2026-09-23):**
  - opencode (`atlarix-references/opencode`, `session/prompt.ts:216-249`, `agent/prompt/title.txt`):
    model = `title` agent → configured `small_model` → newest small model on the SAME provider
    (gemini-flash / gpt-nano / claude-haiku family order) → the user's model. Lowest reasoning
    variant (`smallOptions`), normal output cap (≤32k), temp 0.5. Input = first user message ONLY.
    Output: strip `<think>`, first non-empty line, cap 100. Runs forked in the background on step 1.
  - Codex CLI (`codex-rs/tui/src/app/thread_title.rs`): dedicated small model when available, else
    the user's; reasoning Low; JSON schema `{title, maxLength 36}`; prompt ends "Do not answer the
    request."; input = first user message (≤960 bytes); strips quotes/trailing punctuation; on
    failure no title (list shows the first message). Background; dropped if the user renamed.
  - Claude Code: background Haiku (falls back to the main model where Haiku is unavailable),
    thinking disabled, structured output; titles in the conversation's language; changelog shows the
    same failure class we hit (greeting → junk title, refusal text as title, multi-line titles).
  - Cursor: auto-named from the first input; internals not public.

  **Universal fix for Atlarix:**
  1. *Model chain:* a cheap non-reasoning title model on Core when the account can use Core/Auto
     (Auto's `title` lane already routes to the cheapest level) → else a small model on the user's
     OWN BYOK provider (flash/nano/mini/haiku/lite family from our catalog, or a `small_model`
     setting) → else the selected model. BYOK-only users never fall onto the shared Core key.
  2. *Settings:* lowest reasoning effort / thinking off per provider (wire-case in
     `providerOptions`); NO small output cap (if any, ≥1–2k as runaway insurance); ~10–15 s timeout,
     one retry, temperature ~0.5.
  3. *Prompt:* opencode's `title.txt` style + Codex's "Do not answer the request." + "≤6 words, ≤50
     chars", same language as the user. User turn = "Generate a title for this conversation:" +
     ONLY the first user message (~1 KB, in `<user_message>` tags). Stop sending the assistant reply
     — that is what invites chatty models to reply. Structured output only where the catalog says
     the model supports it; text + sanitise is the universal path.
  4. *Sanitise:* strip `<think>…</think>` (and an unclosed one), parse `.title` if JSON, strip
     markdown / emoji / quotes / a "Title:" label, first non-empty line, collapse whitespace, drop
     trailing `.?!:`, cap ~50 chars on a word boundary.
  5. *Reject "a reply, not a title":* >~8 words or >60 chars, a sentence break followed by more
     text, starts with a greeting (hi/hey/hello/sure/certainly), first person (I/I'm/my) or "you",
     "as an AI" / "I can't", ends with "?", echoes the model's own name, or empty → deterministic
     fallback (no retry on another model).
  6. *Deterministic fallback:* from the first user message — remove code fences, URLs, @mentions,
     markdown and leading filler ("please", "can you", "hey"); first 6–8 words, ≤50 chars,
     capitalised; a bare greeting becomes "Greeting". Show it IMMEDIATELY as the placeholder and
     replace it only with an LLM title that passes step 5.
  7. *Timing:* start in the background on the first real user message (parallel to the turn, never
     awaited); only while the title is still the placeholder; drop the result if the user renamed
     or deleted the session; skip synthetic/tool-only first messages; once per session.
  Same `maxTokens` naming issue in compaction (`src/lib/context/compaction.ts:1160`) — review it with
  the same care (compaction output SHOULD be bounded, but not so tightly a reasoning model returns
  nothing).

- **Session list: the "⋯" menu sits at the very edge and is hard to hit.** Widen the row's right
  padding / give the menu button a larger hit area so delete is easy to click.
- **Selecting an older session leaves the empty "Untitled" / "New conversation" row behind.** When
  the user switches to an existing session, an unused empty session should be pruned (or not
  shown) — the session-reuse log shows `msgs=0,"Untitled"` candidates lingering.
- **Remove the right panel's Console and Network tabs, and their code.** The Chrome extension now
  covers what they were for (console + network of the agent's tabs, over CDP). Delete the tabs,
  the capture plumbing that only feeds them (e.g. `browser_network_capture.ts`, the
  `PageConsole` / Network panel components, their IPC), and update the tool descriptions and
  DESIGN_NOTES "Errors tab → Console + Network". Keep whatever `browser_test` still needs for its
  own failure verdict (`FAILURE_CONSOLE_LEVELS`) — check reachability before deleting.


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
