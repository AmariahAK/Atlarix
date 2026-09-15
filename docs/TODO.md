# Atlarix TODO

**Current version:** v14.46.0 — **tagged 2026-09-15.** The browser extension can build you a
file; skills and connectors from atlarix.dev reach the desktop; the agent stops losing your tab
when you switch away; and the desktop↔extension bridge transport ships **dormant**. Narrative in
[`docs/CHANGELOG.md`](./CHANGELOG.md).

**This header has been wrong before.** It read v14.42.0 while `package.json` said 14.43.0, and
"v14.44 SHIPPED" while **v14.44 was never tagged and has no changelog section at all**. Update it
in the same commit as the version bump, or do not trust it.

**This file is a QUEUE.** It was 3,194 lines at v14.46.0, against its own runbook rule to stay
lean, and most of it was a log of finished work. What was in it now lives where it belongs:

| | |
|---|---|
| What shipped, per version | [`docs/CHANGELOG.md`](./CHANGELOG.md) |
| Findings that cost time to discover | [`docs/TRAPS.md`](./TRAPS.md) |
| Designed, not scheduled | [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) |
| Open work | here, and nowhere else |

**Last updated:** 2026-09-15

---

## 🔭 Open — the queue

### 1. The `target: "app" | "chrome"` seam — the last of the browser bridge

Everything under it is built and verified: the Rust relay (`native/atlarix-bridge`), the framing
and socket server (`src/lib/bridge/`), the lifecycle (`src/main/bridge-lifecycle.ts`), and the
extension's service-worker port (`packages/extension/src/bridge/`). A real Brave profile connected,
answered `ping`, `list_tabs` and `get_url`, and correctly REFUSED `read_page` on an ungranted site
and `close_tab` on a user's own tab.

**What remains is the seam in `src/lib/tools/browser.ts`**, which has three tools and ~25
`webContents` call sites. Four things about it are not obvious and all four are load-bearing:

- **The refusals must be LOUD and NAMED.** `mode:"console"`, `mode:"network"`, `mode:"visual"`,
  `mode:"design"` and `mode:"text"` read from hooks `browser_view_manager.ts` injects per document
  (`:564`, `:583`, `:683`, `:684`); an extension inherits none of them. **An empty console read is
  indistinguishable from a clean page**, which is the worst available lie. Write the refusal test
  before the happy path.
- **`browser_test` does NOT get the parameter, deliberately.** It depends on
  `getBrowserSurfaceErrors` and `runtimeFailuresSince`, and `failOnConsoleError` defaults to
  **true** — so a Chrome-targeted test would return `success:true, "UI verified"` with **zero**
  runtime-error coverage. A false pass on the tool whose whole job is preventing false passes. The
  mitigation is the absence of the parameter, not a warning: the model cannot ask for what is not
  in the schema.
- **The delta promise must be scoped to `target:"app"`.** The tool description tells the model
  "acting returns a light delta … so you usually do NOT need a follow-up `browser_inspect`". That
  delta comes from `withDelta` (`:1097`), a raw-eval splice with no Chrome equivalent. Leave the
  promise unscoped and the model skips its re-read and acts on refs the page has invalidated,
  failing later with an error pointing at the wrong thing.
- **The tool stays OUT of the offered array until the Web Store approves.** Owner's instruction:
  build it end to end, do not tell Atlarix it exists yet. `resolve-toolset.ts:148-201` already
  filters named tools out of the offered array while leaving them registered and executable. One
  more switch, **fixed for the session and never toggled mid-turn** — tool definitions sit inside
  the first prompt-cache breakpoint, and mutating the array invalidates the whole prefix.

Add one kernel op while there: **`text`**. `inspectText` (`:398`) is raw eval with no kernel op,
"read the page's text" is the most-used browser capability there is, and adding it *deletes* a
raw-eval site on the desktop rather than adding one.

Three defects found while mapping, worth fixing in passing: `action-scripts.ts:132` claims
scroll-by "is not a kernel op" but `{op:"scroll"}` has existed at `page-scripts/index.ts:237` since
the kernel refactor; `search-results` is a kernel op with no desktop caller; and `runInPage`'s
`allFrames:false` means a bridged action against an iframed app silently targets the top frame,
where the desktop's `executeJavaScript` has no such ambiguity — **that last one is the only place
the two backends genuinely disagree and it must be surfaced in the result text.**

Per-session tab groups need a storage migration: `tabs/group.ts` keys `windowId → groupId` under
`atlarix.tabGroups.v1`; one group per chat session makes the key `${sid}:${windowId}`, needing
`v2` plus a migration mapping old entries to a reserved `"panel"` session. Do not silently
reinterpret v1 entries.

### 2. Chrome Web Store — v1.0.0 is in review

Item `fkoacefbjjjhjceidagdajkgclfjacbe`, submitted 2026-09-14, **still pending**. It was rejected
once before that for "Spam and Placement in the Store — excessive keywords", on a description line
naming six file formats. `scripts/cws-copy-check.mjs` now enforces that shape (and every field's
1,000-character limit) — run it before pasting anything.

**Owed on the next upload, whenever review resolves:**

- [ ] **Bump `packages/extension/manifest.json` from `1.0.0`.** The store copy in `cws/` is already
      written for 1.1.0; the manifest is not.
- [ ] **Re-paste the Remote code justification.** It described relics only, and 1.1.0 adds
      `run_code`. A disclosure covering half of what an extension evaluates is the kind of
      inaccuracy that pulls a live item rather than merely delaying one.
- [ ] Re-paste Single purpose (gains a clause for producing a file) and Test instructions (gains a
      step that exercises it). All three are in `cws/PRIVACY-FORM.md` / `cws/TEST-INSTRUCTIONS.txt`.
- [ ] Fill the reviewer credentials in the dashboard, not the file, and confirm that account still
      has credit. **A reviewer hitting a zero balance sees an extension that does not work, and the
      rejection will not mention money.**

The API sets the PACKAGE and nothing else — description, screenshots and justifications are
dashboard-only, so no amount of green CI covers the list above.

### 3. CI must resolve the win32 + linux TypeScript 7 platform binaries

Only darwin-arm64 is proven. The last open verification item from the packaged-app batch.

### 4. The Windows `make` residual

Un-pinning the runners to `windows-latest` proved `electron-forge package` on
`windows-2025-vs2026` (MSIX run `34461113885`, green end to end, `toolset v145`). It did **not**
prove `electron-forge make` (Squirrel.Windows), which has never run on that image and which gates
`publish-release`. **If a tag fails there: re-run the job, then revert one line to `windows-2022`
before assuming the maker is broken.** `windows-2022` is kept as a dispatch option for exactly that
A/B.

---

## ⚠️ Known and NOT fixed — deliberately, with reasons

- **The packaged app does not exit after `--self-test`. ROOT CAUSE UNIDENTIFIED.** It prints
  `PASSED (9/9 probes)` and keeps running; a second process boots the app for real, which is only
  possible with `IS_SELF_TEST` false. **Not Windows-only and not new** — the same pattern appears on
  macOS arm64 (2026-09-05) and in a v14.35.0 Windows log that SUCCEEDED, and two consecutive runs of
  the same build differed only in outcome. Mitigated in v14.36.0: the verdict comes from the probe
  REPORT rather than from process termination. **Next step is one observation, not more code
  reading** — a Windows machine, `atlarix.exe --self-test` from a terminal, and Process Explorer to
  see what the second process's parent actually is.
- **`withLock` serialises TWO callers, not N.** `src/ipc/utils/lock_utils.ts` awaits only the lock
  it observed, so with three contenders B and C both wake and both acquire. Correct for two,
  silently not a mutex beyond that. Plan writes already use their own FIFO chain
  (`withPlanArtifactLock`). Changing shared locking semantics deserves its own pass.
- **`useAuth` is an UNSHARED hook with 30+ consumers**, each running its own `checkSession()`.
  Guard in the IPC handler, never in the hook. The sign-out half is scoped:
  `SubscriptionManager.signOut()` does not broadcast `auth:resolved`, so a second window keeps a
  stale session. Fix is one call plus clearing `user`/`status` on a null user — do it with the rest
  of the unshared-hook work.
- **8 conditional-hook violations, visible but not blocking.** `useStreamChat.ts` ×4,
  `SubAgentRunCard.tsx` ×2, `useWorkspacePlanPanel.ts` and `RightPanel.tsx` ×1. They work only
  because the condition happens to be stable for a component's lifetime, which is a property of
  current callers rather than a guarantee. **`useStreamChat` is the risky one** — changing its hook
  ORDER can break streaming. Set to `warn`; raise to `error` once these 8 are gone.
  `react-hooks/exhaustive-deps` (25) is the next rule worth turning on.
- **Local packaged builds report `environment=production` to Sentry — SETTLED, keep.**
  `app.isPackaged` is true for a local ad-hoc build. Deliberate: some bugs are only findable through
  Sentry and separating the environment would put exactly those runs where nobody looks. The cost is
  accepted — **never read production alert VOLUME as a user-impact signal without checking the
  source.**
- **`ai@7`'s `instructions` placement is the aligned end state, not done.** `role:"system"` inside
  `messages` stays permitted so the prompt-cache layout remains byte-identical and measurable.
  Moving it needs its own commit and its own `[prompt-cache] read=` measurement.
- **Accepted advisories, with reasons.** `@huggingface/transformers` → `onnxruntime-node` →
  `adm-zip` → `sharp` has no fix and is the deliberately-pinned voice stack. `shepherd.js` →
  `deepmerge-ts` needs a major; the call site was checked rather than assumed — tour options are
  static literals, so nothing attacker- or model-controlled reaches the merge.

---

## 🔐 Security follow-ups — owner-triaged, deferred

- **Project-wide `TRUNCATE` revoke on the older tables — OWNER'S CALL, still open.** Supabase grants
  all of `arwdDxtm` on every new `public` table to `anon`, `authenticated` and `service_role`, and
  **TRUNCATE IS NOT FILTERED BY ROW SECURITY** — a role holding it empties the table regardless of
  every policy. Proved on the live database 2026-09-14 inside a rollback. Every table created since
  carries the revoke; `users`, `credit_wallet`, `credit_grants` and `conversations` do not. Not
  currently reachable (PostgREST has no TRUNCATE verb) but one bug away from total data loss.
- **`MAINTAIN` is also still granted** on all of those tables. Far milder — it reads and writes no
  data — but the house rule is "no privilege we did not intend". Fold it into the same migration.
- **Native sandbox validation in CI.** `npm run check:sandbox` cross-target type-checks all four
  (helper, target) pairs and the helpers are gated on behaviour, but neither substitutes for running
  them on the real OS.
- **Windows code-signing cert.** The helper sign steps are wired for both the sandbox helper and the
  bridge relay; the secret is not set. Only real fix for the C6 residual on direct-download Windows.
- **Unattended read-only allowlist-flip.** The denylist taxonomy is done; the flip needs
  per-automation design so it does not break legitimate builds and tests.
- Sandbox **read**-confinement (Windows blocker), **egress** gating, and the remaining Mediums:
  env-var key inheritance, secret-basename list, cross-workspace file scope, plaintext-keychain
  fallback.
- **OAuth `state` nonce / PKCE stays NOT DOING.** Attempted v14.12.0, broke sign-in, reverted.
  Revisiting needs confirmation that the Supabase redirect-URL allowlist permits a query param.

---

## 🔜 Blocked on the owner — not active work

- **2026-09-17 — chase GitHub Marketplace if Atlarix Reviewer is still not listed.** Three weeks
  after the App went public (2026-08-27). **FIRST check <https://github.com/settings/apps>** for
  rejection notes or a still-pending review — the answer is often already there. If there is
  genuinely no communication, file at <https://support.github.com/contact> → Marketplace → "App
  review pending for X weeks", with the app name, App ID, the submitting org, and the SUBMISSION
  date (which may differ from the date it went public).
- **Delete the "Atlarix Reviewer" LemonSqueezy product** (`1317705`, variant `2060123`). Zero
  subscriptions ever, checked against the live API. No code references the variant.
- **Archive, do not delete, `AmariahAK/atlarix-skills`.** Archiving keeps the URL read-only;
  deleting 404s it. `atlarix-mcps` is still live and linked from the releases README — leave it.
- **One account holds Pro it never paid for** — `d22ee539…`, `plan = pro` with no subscription and
  no `credit_grants` row. Its `created_at` and `updated_at` are the same second, which is the
  users-INSERT escalation closed on 2026-08-28, used ten days before the fix. It draws no credit and
  has never used Reviewer. Reset to `free` when convenient.

---

## 🧭 Designed — awaiting a session

The reasoning lives in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md); these are the pointers.

- **The CLI.** TUI + loopback-PKCE auth + billing over the headless binary that already ships. The
  full brief is written and does not expire.
- **Core under concurrency.** Mostly solved already — `balance-cache.ts` keys on `userId` and holds
  a per-call reservation, Postgres stays the sole authority, and `spend_from_wallet` takes
  `FOR UPDATE`. **Two residuals:** multi-replica overspend is bounded at roughly one reserve per
  replica per user and is not worth fixing until a second replica exists; but **the reviewer's cost
  attribution genuinely BREAKS on a second replica** — `ReviewQueue.spendSince` reconstructs cost
  from a ledger window that is exact only because one replica is strictly sequential. The fix is for
  the proxy to return the debited amount on the response. **Do this BEFORE scaling the reviewer.**
- **Launchpad Turnstile — deferred with the reason measured**, not merely postponed.

**Anything here becoming real needs a MEASUREMENT first.** The 2026-08-26 lesson stands: 704
Supabase requests/hour looked like website traffic and was a 5-second poll of our own.

---

## 🔭 Long-term — not soon

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat is a money pit and teams already have it. Two pieces instead: (a) **`@atlarix` bots inside
  the tools teams already use** — Slack, Discord, GitHub issues — the shape the PR reviewer already
  takes ([`atlarix-pr-bot-spec.md`](./atlarix-pr-bot-spec.md)); and (b) a **shared, observable agent
  session** where teammates watch one run live, steer, approve and hand off. The chat shell is not
  the differentiator; the shared *agent* session is. Capture, don't build yet.
