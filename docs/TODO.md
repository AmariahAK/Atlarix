# Atlarix TODO

**Current version:** v14.49.0 — **released 2026-09-21.** The UI pass: the composer has a model
chip that names the model you are on (nothing ever did), the sidebar's workspace row is a header
rather than a tree row, session rows are one line, the rail footer is two buttons and a readable
clock, and Integrations shows its provider grid on arrival. Fixed along the way: the sidebar was
painting `--accent` (amber in BOTH themes) where `--sidebar-accent` belonged, two composers could
both answer Cmd/Ctrl+J, a custom model picked from the old sheet lost its `customModelId`, and
the account menu could not be dismissed by clicking away. Net −383 lines. Narrative in
[`docs/CHANGELOG.md`](./CHANGELOG.md).

v14.48.1 (2026-09-17) SHIPPED: the Chrome extension was INERT in Arc — the background worker
threw on `chrome.sidePanel` before the bridge below it could connect.

**This header has been wrong before.** It read v14.42.0 while `package.json` said 14.43.0, and
"v14.44 SHIPPED" while **v14.44 was never tagged and has no changelog section at all**. Update it
in the same commit as the version bump, or do not trust it.

**This file is a QUEUE.** It was 3,194 lines at v14.46.0, against its own runbook rule to stay
lean, and most of it was a log of finished work. What was in it now lives where it belongs:

|                                     |                                             |
| ----------------------------------- | ------------------------------------------- |
| What shipped, per version           | [`docs/CHANGELOG.md`](./CHANGELOG.md)       |
| Findings that cost time to discover | [`docs/TRAPS.md`](./TRAPS.md)               |
| Designed, not scheduled             | [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) |
| Open work                           | here, and nowhere else                      |

**Last updated:** 2026-09-21

---

## 🔭 Open — the queue

### 1. The `target: "app" | "chrome"` seam — BUILT, awaiting a live end-to-end pass

The seam is written and the suite is green (5,057 passing). `browser_inspect` and `browser` both
take `target`, defaulting to `"app"`; `src/lib/tools/browser-target.ts` owns the whole Chrome path
so the 46 `webContents` call sites keep their single meaning.

**What is done, and the four load-bearing constraints all honoured:**

- Refusals are loud and named, and each one says the next move. `visual`, `design`, `console`,
  `network`, `screenshot`, `key`, `hover` and `tabs operation:"switch"` each explain *why* rather
  than reporting a generic failure. Every one is a returned result, never a throw, so the model can
  recover to `target:"app"` inside the same turn. The refusal tests were written first.
- `browser_test` has no `target`, and its description now says so.
- The delta promise is scoped to `target:"app"` in the `browser` description.
- The store link is derived from `BRIDGE_EXTENSION_ID` (`host-install.ts` exports `CHROME_STORE_URL`),
  so the id still exists exactly once. It appears in the not-connected refusal — where someone is
  actually blocked — and not in the schema, which is on every turn's prompt prefix.

**Owner decisions folded in:** the tools stay offered in **every** mode (Explore/Plan/Build/Debug/
Review — pinned by a test; `browser` survives the read-only modes because it mutates the open page
and never the workspace). And the agent **prefers its own tab group**: `targetTab` used to fall
through to the user's ACTIVE tab, so "read the page" meant whatever they had just switched to.
It now prefers the agent's own tabs, a new `navigate` op reuses the agent's tab rather than breeding
one per call, nothing ever activates a tab, and `navigate`/`close_tab` both refuse a tab the user
owns. The user's tab is still reachable — by `tab_id` from `list_tabs`, which flags `active` and
`agent`.

**Defects found and fixed while mapping** (each was a silent wrong answer, not an error):

- **Bridged `scroll` never worked.** It sent `{ref, to, by}` to a kernel op that reads
  `{direction, amount}`, with an `as never` silencing the mismatch — so `direction` was always
  `undefined` and every scroll went DOWN one viewport. Never up, never to top/bottom, `by` ignored.
- **The `text` fallback leaked script source.** `innerText ?? textContent` returns the *source* of
  `<script>`/`<style>`; the kernel now strips them on a clone. jsdom has no `innerText`, so the new
  test exercises exactly that path.
- `action-scripts.ts` claimed scroll-by "is not a kernel op" — it has been one since the kernel
  refactor. The comment now says what is actually true: the desktop keeps its own builder for
  horizontal scrolling and the AI cursor, neither of which the kernel op does.

`text` is now a kernel op shared by both backends, and it **deleted** a raw-eval site: `inspectText`
routes through `kernelCall` instead of splicing its own `querySelector`. `PAGE_TEXT_MAX_CHARS` moved
into the kernel module so both clip at the same point.

The `allFrames:false` disagreement is surfaced, not resolved: a Chrome read that comes back
near-empty appends a note saying the extension reads the top frame only and to retry with
`target:"app"` before reporting the page as blank.

**What is NOT done:**

- [ ] **A live end-to-end pass.** The relay binary is not built in this checkout, so
      `resolveRelayPath()` returns null and the "no bridge in this build" branch is what runs here.
      `cargo build --release` in `native/atlarix-bridge` is a prerequisite, not an optional extra.
      Then: `ping` first, then a granted read, then `mode:"console"` to confirm the named refusal
      and the model's recovery, then close the browser to confirm the install link appears.
- [ ] The TODO's old claim that `search-results` has no desktop caller was stale —
      `src/lib/search/browser-search.ts:117` calls it. No action, recorded so it is not re-checked.

Per-session tab groups still need a storage migration: `tabs/group.ts` keys `windowId → groupId`
under `atlarix.tabGroups.v1`; one group per chat session makes the key `${sid}:${windowId}`, needing
`v2` plus a migration mapping old entries to a reserved `"panel"` session. Do not silently
reinterpret v1 entries. (Not required by the work above — the single per-window group is what ships.)

### 1b. Desktop-driven browsing does not ask, and does not manage

**Host access is a REQUIRED `host_permissions` entry** (`http://*/*`, `https://*/*`) as of
2026-09-17. Chrome grants it at install, Site access defaults to "On all sites", and a
desktop-driven request simply runs. `bridge/serve.ts` has **no permission check at all** —
`requireGrant` is gone, replaced by a `tabUrl` lookup. If a user narrows Site access from
chrome://extensions, `chrome.scripting` refuses the injection and Chrome's own error surfaces.

**Three rounds of live testing died on the gate this replaced**, and each of my fixes was more
machinery in front of a door that should have been open: a clearer refusal, a toolbar badge, a
panel banner, a proactive offer. All of it is deleted. Owner: *"no adding more security doesn't
work… it should work, it doesn't need to manage anything."* The lesson worth keeping is that a
permission whose remedy lives in a different window from its failure is not a permission, it is
a dead end — and I answered it four times before removing it.

**The panel's own agent is unchanged** and still asks per site (`canActOn` stays a
conjunction). That asymmetry is now the safety story: broad access exists for the desktop
integration; the in-browser agent keeps a self-imposed limit.

**Known consequence, accepted:** `permissions.remove()` cannot take back a REQUIRED permission,
so `revokeHostAccess` no longer stops the desktop path — it drops the panel's record and
catches the Chrome call, which would otherwise reject and turn the settings "Revoke" button
into an error. Revoking on the account page therefore constrains the PANEL only. The honest
control for the desktop path is Site access in chrome://extensions.

**Store copy rewritten and re-checked** (`node scripts/cws-copy-check.mjs`): Single purpose
(988), `scripting` (836), a NEW **host_permissions justification** (905), and
`cws/DESCRIPTION.txt`, which claimed *"Atlarix never asks for access to every site you visit,
and it ships with access to none"* — public-facing and now false, which is the kind of
inaccuracy that pulls a live item rather than delaying one.

- [ ] **The next submission is on the MANUAL review track** — a permissions addition — and the
      install prompt becomes "Read and change all your data on all websites". Both were taken
      deliberately; see the plan file.

**Also landed:** console and network capture over CDP (`page/cdp-capture.ts`), with
`Network.enable` raced against a 2s timeout because the v14.31.0 trap is a HANG, and
`unavailable` carried separately from an empty list. And a **build id** — a hash of the 75
bundle inputs, sent in the handshake and logged by the desktop — because the extension version
follows the app's and so cannot distinguish rebuilds. A stale extension load cost a full round
of testing before it existed.

### 2. Chrome Web Store — v1.0.0 is LIVE; 1.0.1 is built and not yet submitted

Item `fkoacefbjjjhjceidagdajkgclfjacbe` is **published**. The two starred permission justifications
(nativeMessaging, alarms) are written and **saved as a draft** in the dashboard.

`packages/extension/dist/atlarix-extension-1.0.1.zip` is rebuilt (142.5 KB, 16 entries) with the
manifest and package.json both at 1.0.1. Its user-visible changes are the `text` and `navigate` ops
and the scroll fix.

**Submit AFTER the live desktop↔extension pass, not before** — a CWS update starts a review that
cannot be recalled, and 1.0.1 exists to be called by the desktop side. Note that a user still on
1.0.0 asking for `mode:"text"` gets the extension's own honest refusal: *"This build may be older
than the desktop app asking."*

Review is hybrid automated/manual, **every update is reviewed**, and a permission addition pushes
the item onto the manual track. 1.0.1 adds no permissions.

It was rejected once, before publication, for "Spam and Placement in the Store — excessive
keywords", on a description line naming six file formats. `scripts/cws-copy-check.mjs` enforces that
shape (and every field's 1,000-character limit) — run it before pasting anything.

**Owed on the next upload:**

- [ ] **Re-paste the Remote code justification** if `run_code` ships. It described relics only. A
      disclosure covering half of what an extension evaluates is the kind of inaccuracy that pulls a
      live item rather than merely delaying one.
- [ ] Re-paste Single purpose and Test instructions if that ships too. Both are in
      `cws/PRIVACY-FORM.md` / `cws/TEST-INSTRUCTIONS.txt`.
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

### 5. Launchpad — the three doors are two-thirds built (different repo)

`atlarix-launchpad`, not this one. Atlarix is three surfaces in three SEO/GEO categories —
desktop app, Chrome extension, PR reviewer — and the plan is one entity behind three doors on one
domain, because LLMs and listicles answer by CATEGORY and "best AI coding agent" is the most
crowded of the three.

**Most of it already exists.** Routes `/`, `/reviewer`, `/extension` (`src/App.tsx:52-53`); the
site is statically generated (`vite-react-ssg`), so all three ship real HTML; `structured-data.ts`
already has `desktopApplication()` (`DeveloperApplication`), `browserExtension()`
(`BrowserApplication`, with `isPartOf: {"@id": APP_ID}` tying it to the app entity), `faqPage()`,
`graph()`; `public/llms.txt` lists all three; sitemap + IndexNow are wired.

What is actually missing:

- **`/reviewer` emits NO JSON-LD at all.** `Reviewer.tsx:55-59` passes no `jsonLd`, while
  `Index.tsx:52` and `Extension.tsx:61` both do. Needs a `reviewerApplication()` beside the other
  two, following `browserExtension()`'s `isPartOf` pattern. Honest caveat: schema.org has no
  "code review" category, so it is `DeveloperApplication` again — the category field does less
  work here than the three-doors idea implies.
- **Three divergent `FAQPage` implementations.** `faqPage()` in `structured-data.ts` is used by
  **nobody**; `FAQ.tsx` is orphaned (no importer) and hand-rolls its own; `PricingPage.tsx:33-41,
  114-118` hand-rolls a third and injects it with raw `dangerouslySetInnerHTML`, bypassing
  `graph()` so it never joins the Organization/WebSite graph. Route all three through `faqPage()`
  + `usePageMeta`, then add FAQ blocks to `/reviewer` and `/extension`.
- **A "better together" page** — the workstation hands context to the Reviewer and the Reviewer
  judges it independently. The one claim nobody can copy, and it only exists because we own both
  halves. New route takes `{ path, element, entry }`; the sitemap auto-discovers built HTML, but
  add it to the `PAGES` map for `lastmod` and to `RULES` for a third-door priority.

**Do not expect this to move the numbers.** Per the 2026-09-18 baseline, 89% of clicks are the
literal word "atlarix" and **/pricing has never been crawled** — the bottleneck is AUTHORITY, not
markup, and schema on a page nothing reaches changes nothing. This is foundation. The movement
comes from the CWS listing, the GitHub Marketplace listing (still not approved as of the
2026-09-16 chase) and staggered launches, which are crawlable third-party pages we do not have to
build authority for from zero.

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
- **Accepted advisories, with reasons.** The `@huggingface/transformers` → `onnxruntime-node` →
  `adm-zip` → `sharp` chain that had no fix is GONE — the on-device voice stack it belonged to
  was deleted in v14.50.0, so `npm audit` no longer lists any of the four. `shepherd.js` →
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

- **GitHub Marketplace — CHASED 2026-09-16, now waiting on GitHub.** The listing
  (`atlarix-reviewer`) shows "Pending for publish" with every checklist item complete and no
  requested change, three weeks after the 2026-08-27 submission. **GitHub Support no longer has a
  Marketplace category** — `/contact` redirects to a six-option flow (Copilot, Codespaces,
  Repositories, Education, Sign-in, Billing) and `/contact/marketplace` redirects into it; the only
  surviving "GitHub Marketplace" control is a product dropdown under Billing whose required
  trouble-reason field is payments-only. So the chase went to the community forum instead:
  <https://github.com/orgs/community/discussions/208022> (Apps, API and Webhooks / Question).
  Other publishers report the same silence at 30 days and 3 months, so this is a queue backlog
  rather than anything about our listing. **Do not touch "Withdraw request"** — it returns the
  listing to the back of the queue.
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
  the differentiator; the shared _agent_ session is. Capture, don't build yet.
