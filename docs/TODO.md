# Atlarix TODO

**Current version:** 15.13.3 (2026-11-06; 15.13.0-15.13.2 never released as desktop builds; 15.13.2's VS Code extension did ship): Windows CLI/editor sign-in kept without the desktop app, plaintext secrets encrypted, crash-proof usage counts, auto_consent event. 15.13.0: sessions wake and review each other, peer messages visible on every surface, ask_user like Claude Code's, CLI send-now (ctrl+s) and long-chat repaint, 1h cache + idle compaction, prompt-truth audit.

**This header has been wrong before.** Update it in the same commit as the version bump, or do
not trust it.

**This file is a QUEUE.** Only work that is not yet done belongs here.

|                                     |                                             |
| ----------------------------------- | ------------------------------------------- |
| What shipped, per version           | [`docs/CHANGELOG.md`](./CHANGELOG.md)       |
| Findings that cost time to discover | [`docs/TRAPS.md`](./TRAPS.md)               |
| Designed, not scheduled             | [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) |
| Open work                           | here, and nowhere else                      |

**Last updated:** 2026-11-06

---

## ➡️ Next session (from the 2026-11-06 coordinator; none of these block a release)

**Wallet hardening — DONE 2026-11-06** (audit report ~/.atlarix-e2e/team/REPORT-security-items-2026-11-06.md):
migrations 20261106160000 (debits lock the wallet before checks; no ban refusal; service floor -$50),
20261106161000 (paid_holds + service RPCs), proxy a8506f1 live on Railway + failover (user charges via
debit_wallet_service; Lambda paid turns hold in the DB), then 20261106170000 (debit_wallet revoked from users;
verified authenticated/anon cannot execute). Files on main 9c757079.
- VERIFIED 11-06 13:05 UTC: the owner's paid CLI run left 6 auto_paid debits with the `:<uuid>` ref suffix, no
  hold left behind, no hold/debit errors in Railway logs.
- Gaps closed the same day (proxy 453602d, live on both): search/transcription take the DB hold; every runtime
  takes it (Railway too, ~25-40 ms per paid turn); a banned ASKER is refused when a workspace pays. Only
  insufficient_funds refuses: a DB that can't be asked gives HOLD_UNAVAILABLE and the call runs on the in-memory check.
- Small: upsert_account_skill has no row cap/ban check; record_session_feedback no ban check;
  free_usage_user_daily.turns may count Requesty turns twice (unverified).

**Done 11-06 evening:** Google ID-token sign-in ON for everyone (owner's test passed; launchpad 5099a6c) ·
permission "reason" merged (989accbd, ships next release) · Medium post published · YouTuber outreach handed to
ai-4b (tracker ~/.atlarix-e2e/team/outreach-youtubers.md; owner approves each batch before sending).
PeerPush 15.13 update posted (site moved to peerpush.com; Product page → Post Update).
**Waiting on the owner:** Reviewer install for AmariahAK doesn't cover the Atlarix repo
(no reviews there since 08-26) · Medium + PeerPush posts · winget PR #446527 (moderator).

**Reviewer in Actions follow-ups (ai-37 E2E passed 11-06):** claim window 3 → 5 min (GitHub's dispatch→run was
~90 s); a superseded job spent ~40 s on API reads before noticing; Railway logs console.warn at error severity +
an ECONNRESET after the last poll (noise); atlarix-cloud-test still has review_in_actions: true on @main.

**Release:** the only app change since 15.13.3 is the sandbox card scrolling a long command (76daf2a1); it rides
the next release, no 15.13.4 for it alone. Everything else from 11-06 is server-side and already live.

## 🔨 Round 2026-11-05 → 15.13.0: what is still open

- **Proxy origin lock (Cloudflare) — prepared, NOT switched on.** Railway http log, 11-05 03:23–15:50 UTC: 183 of 501
  requests used `atlarix-production.up.railway.app`: 150 `/health` from our AWS uptime Lambdas (eu-west-1) and **26
  chats from two outside IPs on an older CLI** (bun, ai-sdk/openai-compatible 3.0.31). An old client falls back to
  the Lambda only on 502/503/504, so `ORIGIN_LOCK_SECRET` now would cut those users off. Switch it on when 15.13's
  auto-update has moved them and the raw-URL chat count is ~0 (re-run the same log query). Before that: Cloudflare
  Transform rule (`x-atlarix-origin` = the secret in ~/Documents/Atlarix-security/origin-lock-secret-2026-10-30.txt),
  the reviewer sends the header (it can keep the raw/private URL), and the cloud agent's `claim.core_proxy_url`
  becomes `https://core.atlarix.dev` (customer runners can never hold the secret). The Lambda failover stays open
  (CloudFront + WAF costs money: owner's call).
- **"proxy copies differ" alarm compares commit labels, not code.** The failover stamps the last commit that touched
  deployed paths (`git log -1 -- src …`); Railway reports `RAILWAY_GIT_COMMIT_SHA`, the commit it was deployed AT. A
  Railway redeploy at a config-only commit (a `railway config apply`, 11-05: 1f4f0b1 vs f0f94fa, zero src diff) makes
  them differ until the next code change, and the alarm mails hourly. Fix: both builds stamp a hash of the deployed
  files (same path list, one shared script for tsup and esbuild) and the uptime Lambda compares that, commit as fallback.
- **Railway config is code now:** `.railway/railway.ts` is omit=delete (an apply deletes any variable it doesn't list).
  After adding a variable on Railway, add its name there; always read `railway config plan`'s destroy count first.
- **Slack says "Change who pays at …/cloud", but the live site has no payer control:** it is only on the unmerged
  launchpad branch `team/workspace-pays-web` (6e8c991). Merge it or change the Slack line.
- **Found while filming 15.12 (cc-video, 11-05):** a blocked tool row in the CLI repeats a truncated "B… ·" prefix.
  (The repaint and the raw-id footer were fixed in 15.13.)
- **Reviewer in the customer's Actions runner (Phase 7a):** built and tested (atlarix-reviewer b265ae6,
  atlarix-agent-action b52ef9f, branches `team/review-in-actions`), opt-in via `review_in_actions: true`. Waiting on
  the owner adding atlarix-cloud-test to the Reviewer app's repository access, then deploy + E2E (runner review,
  workflow missing → API, a new push cancels).
- **Read dedup ("file unchanged" note): decided NO** (data: same-turn repeats ~3% of read tokens; Claude Code removed
  its version in 2.1.317 after stale-tracking bugs). Don't re-propose without new data.

## 🔎 Sign-up → no use (2026-11-06, ai-4b; ~/.atlarix-e2e/team/REPORT-signup-no-use.md)

- **Usage counts lost when a process never reaches its send — FIXED on `team/usage-rollup-persist`, verify after it
  ships.** `client_usage_daily` was counted in memory and sent 15 min after the first turn or at quit (the last
  quit step, 1.5 s cap). A kill, crash, Windows sign-out/shutdown or installer restart skips all of it. Evidence:
  one account had a PostHog `turn_completed` on 11-03 (a `consent_required` turn, app 15.11.1 win32) and no row and
  no proxy request, so the morning mail said "opened, no turn yet"; two app accounts show 6 turns in PostHog against
  4 in the table. Fix: each turn writes this process's unsent rows to `<userData>/usage-pending/<pid>.json`; the
  next process (app onReady, `AgentSession.start`, or its first turn) claims dead processes' files by rename,
  merges, and sends with its own. Rows older than yesterday are dropped (the RPC refuses them, by design since the
  10-29 hardening). Tests: `usage-rollup-pending.test.ts`, `tests-bun/usage-survives-kill.test.ts` (real SIGKILL
  before any send). **Verify:** a week after the release, compare PostHog `turn_completed` people per day with
  `client_usage_daily` users per day for analytics-consenting accounts; they should match.
- **The free Auto consent was not measured — `auto_consent` event ADDED on `team/auto-consent-event`.** Of 25 new
  accounts that opened a client (10-24 → 11-05), 5 reached the consent (a `consent_required` turn) and 2 never ran free
  Auto after it, but shown / accepted / declined were recorded nowhere. Now `auto_consent` {action: shown | accepted |
  declined, trigger: picker | refused_turn | reask, version (the wording's), surface} from the app's dialog
  (posthog-js), the CLI dialog and the editors' permission card (captureSafe); both only with the user's yes to
  analytics. Wording and flow unchanged (owner's decision). **Read it** a week after the release: PostHog,
  `auto_consent`, breakdown by action and trigger.
- **`/auth/app` sat on "Returning you to the app" for good when atlarix:// opened nothing — FIXED on launchpad
  `team/auth-app-fallback` (0a8a72c), deploys with the launchpad.** After 4 s with no blur/hide it offers "Open
  Atlarix" (same link, from memory), "Download for <OS>" (/#download) and "Or open Atlarix and sign in there."
  Desktop email sign-in only. Not measurable before; no event yet for "the app never opened".
- **Windows CLI/editor sign-in was never kept without the desktop app's key — FIXED on `team/cli-os-key-create`.**
  Evidence: 5 Windows people (and 1 Linux) completed 2-4 sign-ins within minutes, each on the SAME account and each
  a NEW auth session; none on macOS. Cause: the CLI seals its session with the desktop's OS key; on Windows it only
  READ `%APPDATA%\Atlarix\Local State` (`os_crypt.encrypted_key`), which exists only after the desktop app ran (the
  Store app keeps its AppData in its package). No key → `isEncryptionAvailable()` false → "the session was NOT saved"
  → the next CLI or editor process is signed out. Fix: create the key the way Chromium does (32 random bytes, DPAPI
  CurrentUser over PowerShell stdin, `base64("DPAPI"+blob)`, merged into Local State, written atomically); never
  replace a key that won't unwrap or a file that isn't JSON. macOS already created its keychain item. Tests:
  `oscrypt.test.ts` (fake DPAPI). **Checked on Windows (2026-11-06, Server 2022 spot i-04ffd13d1dc26bb02, as SYSTEM
  over SSM, terminated):** released 15.12.5 CLI on a fresh profile made no key and stored a provider key in PLAINTEXT;
  this branch's CLI created Local State, stored it encrypted, a second process read it; the packaged 15.12.5 desktop
  ran `--doctor` once (credential-store OK) and the raw key was the SAME 32 bytes after (Chromium re-wraps it and adds
  `audit_enabled`, so the base64 string changes; the key does not); the CLI still decrypted its secret. **Open:** (1)
  an interactive user's sign-in end to end (needs a device code; SYSTEM was used so DPAPI, CLI and app shared one
  user); (2) MSIX: per Microsoft's doc a
  packaged app opens its private AppData copy first and the real file when it has none, so a key the CLI made BEFORE
  the Store app first ran is shared; a Store app that ran first keeps a private key the CLI can't see (the CLI's own
  sign-in is still kept with its own key). **Plaintext provider keys** an older CLI wrote with no key
  (`encryptionType: "plaintext"`; seen on the Windows check) are re-encrypted at the next CLI/editor start once the key
  exists (`secureStoredSecrets`: the desktop's recovery, now also run by the CLI), and `writeSettings` is atomic (0600
  temp file, then rename; the direct write if Windows refuses the rename). With no key they stay, and stderr says
  "Provider keys are stored unencrypted in <file> (no OS keyring found)." **The database's secrets** written the same
  way (MCP OAuth tokens and client registrations, MCP API keys, env and header values, custom provider keys) are
  encrypted at every database start once the key exists (`db/plaintext-secrets-migration.ts`, replacing the api_key-only
  legacy migration). (3) Linux: still read-only (a secret-tool key would not match Chromium's
  libsecret schema); with no keyring `atlarix login` now says "Signed in for this run only: no keyring found …", and
  secret-tool / PowerShell calls time out after 10 s instead of hanging.

## 🔐 Sign-up check: every path, and the parts that never ran (2026-11-06, ai-4b, branch team/signup-check-every-path)

Owner: "43 accounts created in 14 days but only 24 signup checks logged … probably OAuth never goes through the
disposable-domain check". The data says no path skips it. Supabase calls the before-user-created hook for email,
Google and GitHub alike, and every one of the 22 accounts created since 10-30 has its `signup_attempts` row. The 20
accounts without one were created 10-23 → 10-29, before the hook went live. No code creates users another way
(`cli-device` only hands over an existing session). What WAS broken:
- **The 10-30 "learned, not only listed" hook was never deployed.** Production ran version 4 (10-29): a list check
  only, and no mail host, website or age sent. That is why all 39 rows have them empty.
  - milbox.pp.ua (10-27) predates the hook.
  - chapter.lat (10-31) was allowed because the list then held 2 hand-added domains (the 9,966-domain list landed
    11-02 23:52) and the judge had nothing to judge.
  - Fix: the decision moved to `decide.ts` (tested). Lookups go over DNS-over-HTTPS (a plain fetch), not
    `Deno.resolveDns`. The hook's own failures (no email, check RPC down, a throw) are recorded as
    `no_email` / `check_failed` / `check_error`. Then **deploy it** and check the next row has `mx_host` filled.
- **The weekly blocklist re-pull failed** (11-02 04:17: relation "disposable_email_domains" does not exist):
  `SET search_path TO 'public, extensions'` is one schema with a comma in its name. Fix: migration
  `20261106120000_refresh_disposable_domains_search_path.sql`, plus a guard test over every migration.
- No current account other than the two banned ones is on today's list.

## 🚨 Attack 2026-10-28 (19:12–02:30 MYT): what held, what was closed, what is left

One throwaway account (`istevens599@6gdfg.zone.id`, user `88e201ae…`, one Google Cloud IP 34.145.17.47) fuzzed every
endpoint for ~7 h. The owner's notes are in the calendar ("Atlarix alerts fixes", 2026-10-29). Facts checked 2026-10-29:

- **Money:** 14 `debit_wallet` calls with `p_cents` up to 2^31 took its wallet to −8,589,934,601 cents (int32-shaped
  fuzz; the column is bigint, nothing overflowed). No other wallet is negative. The owner reset its balance to 0, so
  its ledger rows (sum −8.59e9, kind `debit`, source `app`) no longer match its balance: anything that SUMS debits
  (revenue or spend charts) must exclude this user or get a compensating `adjustment` row of +8,589,934,601.
- **Proxy (Railway http log, 501 requests from the IP):** 110 free-Auto chats answered 200, then 123 × 402 and 2 × 429,
  so the per-user share held. 45 `/v1/mcp/call` returned HTTP 200, but 33 of 238 logged calls were `ok`, ALL to the
  attacker's own public test servers (httpbingo canned JSON, webhook.site). The ~230 connectors it registered were an
  SSRF suite (169.254.169.254 and metadata.google.internal, Railway-internal hosts, nip.io/sslip.io/1u.ms/rbndr.us
  rebinding, NAT64, 6to4, hex/octal/decimal IPs, redirect-to, userinfo tricks): every private target was refused or
  unreachable. `POST /v1/connectors/probe1/credential` → 200 was `{ok:false,error:"not_found"}` (ownership is
  checked), not a stored credential.
- **Supabase:** 148 forged Lemon webhooks 401; RLS held; `send-email` was an open relay (client chose `to`, subject
  and body), 28 sends, none to a real person (Resend, owner).

**Closed 2026-10-29 (ai-2c):**
- Migration `20261029030000_harden_wallet_and_usage_after_attack.sql`, APPLIED: `account_is_banned(uuid)` reads
  both `users.banned_at` and `auth.users.banned_until`; `debit_wallet` refuses banned accounts, caps one call at
  5,000 cents and refuses a debit that would take the wallet below −5,000 cents; `get_credit_balance`,
  `record_client_usage`, `record_client_seen` refuse banned accounts. ACLs verified (authenticated keeps
  `debit_wallet`; the helper is service_role only).
- `public.users.banned_at` set for the attacker (the auth-level ban alone was invisible to app checks).
- `send-email` edge function REPLACED by a stub answering 410 (version 49): nothing in the app, website or reviewer
  calls it (`src/lib/email/resend.ts` is dead code). If transactional email returns, the server picks the recipient
  (the signed-in user) and a fixed template, never the client.
- Proxy SSRF guard (atlarix-proxy main): IPv6 judged by global-unicast (2000::/3) minus 6to4, Teredo and
  documentation, mapped/translated addresses judged as their IPv4; IPv4 adds 198.18.0.0/15 and the TEST-NETs. Tests
  for every probe spelling. Residual, written in `ssrf.ts`: DNS rebinding between check and fetch (rbndr.us) needs
  resolve-then-pin.

**Left for the proper fix (owner):**
- Delete or keep the attacker's ~230 `account_mcp_servers` rows (inert: banned on both levels).
- The ledger compensation row or an exclusion in every spend chart (above).
- PostHog token leak + revocations and the CLI handoff to PKCE (the 2026-10-28 plan; unchanged).
- Resolve-then-pin in the proxy's connector fetches; rate-limit connector creation per account (230 in one night).
- An alert when one account's refusals, failed webhooks or edge-function calls pass a threshold in an hour: this ran
  for 7 h before anyone looked.
- Bedrock/free-Auto cost for the IP: not checked here (110 free chats at most; the daily digest has the number).

## 🔨 Handover 2026-10-25 (ai-27) — 15.11.1 released overnight; what is left

- **Microsoft Store: 15.11.1 SUBMITTED, in Certification (2026-10-25 ~08:20 MYT), replacing 15.11.0 (owner's call).**
  Submission 32 now carries the support info the 10.6.3 rejection asked for (https://atlarix.dev, support@atlarix.dev).
  The package was built by `msix.yml` `store_resubmit_run` (run 40142829118, the release run's Landlock helper, strict
  sandbox check) and uploaded by the owner in Partner Center, because the API refuses to refill a cancelled draft:
  `PUT` → 409 "InvalidState … PreProcessing" while `--status` says "Canceled". **Fix `store-submit.mjs`:** "Canceled" is
  not reusable through the API; stop with a message that says to upload in Partner Center (deleting would lose the
  support info). Don't replace this submission; wait for Microsoft.
- **Done 2026-10-25 morning (security leftovers):**
  - Actions secret `OPENAI_API_KEY` deleted; inactive IAM keys …FOFY and …GNQH deleted (…KVKO, …7FFI in use).
  - Proxy: `OPENROUTER_FREE_API_KEY` (dead, 401) and `VIRUSTOTAL_API_KEY` (unused) removed; VirusTotal also removed
    from Supabase. `.railway/railway.ts` still lists `VIRUSTOTAL_API_KEY: preserve()`: drop it at the next proxy push.
  - Discord: both webhooks regenerated by the owner ("Atlarix Releases v2", "Atlarix Core Logs V2"), set on Railway,
    the Actions secret and Supabase; both answer. No edge function reads either Supabase copy.
  - Edge functions (bind-github-install, cancel-subscription, cli-device, handle-lemon-webhook, relics) use the
    `sb_secret` key (b4096620), deployed and smoke-tested; then the **legacy JWT keys were DISABLED** (the 24 h log
    showed only Supabase's own `supabase_admin` using a JWT apikey). Re-enable on the API Keys page if anything breaks.
  - Slack Events and Interactivity Request URLs point at the inbox Lambda (Slack verified the challenge). Not yet
    seen with a real Slack event: check a `[trace] {"area":"inbox"…}` line after the next Slack message.
  - Unmerged branches kept on origin, worktrees removed: launchpad `team/logging-15-11` (e743ddd, site sign-in records
    where the account started: the site half of Dev 3 logging, never merged) and reviewer `team/slack-byok`
    (82c2b8b, moot since the cloud agent is paid-only).
- **Supabase billing banner (2026-10-25):** the dashboard says "Grace period is over: your projects will not be able to
  serve requests when you use up your quota". Owner: check Usage / billing.
- **Owed checks:** the Windows approval toast (named chat, click opens it; Squirrel + MSIX) needs a signed-in app in
  the VM, so one owner device-code approval as agent@. The Mac notification click is the owner's check.
- **New free users pick a paid Core model first and hit a misleading refusal: fix on EVERY surface (owner,
  2026-10-27).** Both CLI sign-ups of 2026-10-26 (Linux, 15.11.1, $0 wallet) chose a Core tier in their first minute
  (core-1, core-5), got 402 quota, then switched to Auto, OK'd consent and worked (PostHog `turn_completed`;
  `prev_model` null on turn 1 = picked, not a default; every surface defaults to `core-auto`). The owner wants both
  fixes on all four surfaces, with a QA confirmation on each:
  - **1. Say Core costs credit wherever a model is picked** (for accounts without Pro or credit), the same way Auto
    is tagged "Free":
    - App: `src/components/ModelPicker.tsx` (and the chat's model menu, `ChatConfigDropdown.tsx` / `ChatInputControls.tsx`).
    - CLI: `/model` (`openPicker` in `src/cli/tui/App.tsx`), which tags Auto "Free" but shows Core rows with only a
      context size.
    - VS Code panel: `packages/vscode/webview/chat/picker.ts`.
    - ACP editors (Zed, JetBrains): the session model options in `src/cli/acp/agent.ts` (the option name or
      description is all the editor shows).
  - **2. "Your Atlarix Core balance is used up" is wrong for an account that never had a balance.** For a $0,
    never-topped-up account, say Core runs on credit, keeping the way out: `/billing` (add credit or Pro) and Atlarix
    Auto (free). The text lives in `CORE_EXHAUSTED_MESSAGE` (`src/shared/billing_copy.ts`); each surface matches it
    by marker, so add or keep a marker every surface recognises:
    - App: `src/components/chat/ChatErrorBox.tsx`, `src/components/SimpleInlineChat.tsx` (its Add credit / Upgrade
      to Pro / Auto buttons must still show).
    - CLI: `src/cli/tui/limits.ts` (`errorNotice` keys on `CORE_EXHAUSTED_MARKER`).
    - VS Code panel and ACP editors: they receive the CLI's error text, so check the hint line still renders there.
  - **Approved wording (owner, 2026-10-27; use exactly):**
    - Picker tag for Core, accounts with no Pro and no credit: `Credit` (muted) in the app, CLI and VS Code panel,
      next to Auto's `Free`; in ACP editors the model's description says `Uses credit` (Auto: `Free`). Pro users and
      anyone with a balance see no tag.
    - Refusal for a $0 account that has NEVER added credit: "**Atlarix Core models run on credit.** Add credit or get
      Pro to use them, or switch to Atlarix Auto, which is free." Plus, when the proxy sends `required_cents`: "This
      model needs at least $X of credit." App: the existing Add credit / Upgrade to Pro / Use Atlarix Auto buttons
      under it. CLI, VS Code panel and ACP: title "Atlarix Core runs on credit", detail "Add credit or get Pro to use
      it, or switch to Atlarix Auto (free).", actions "/billing add credit or get Pro · /model Atlarix Auto (free) or
      your own key".
    - An account that HAD credit and spent it keeps today's "Your Atlarix Core balance is used up" message.
  - **QA (full confirmation):** a fresh free account with a $0 wallet, on each of app, CLI, VS Code panel and Zed:
    the picker shows Core as paid, picking it gives the new wording plus the `/billing` / Auto way out, and a paid
    account (Pro or credit) sees no "Credit" tag and no change in the refusal it can still get.
- **Sentry: two issues from 2026-10-24/26 (owner, 2026-10-27).**
  - ~~**ATLARIX-46, CLI browser sign-in crash**~~ **FIXED 2026-11-02** (`dae37447`). `let port` hoisted to outer
    Promise scope in `src/cli/auth/browser-sign-in.ts`; post-close requests answered 503; test added.
  - **ATLARIX-47, new sessions not visible in other open windows until the SQLite poll tick** — **FIXED 2026-11-02**
    (`e0cb0f2b`). `insertWorkspaceSession` in `src/ipc/handlers/workspace_session_handlers.ts` now calls
    `broadcastToAllWindows("sessions:changed", {})` immediately on insert, so all open app windows see the new
    session without waiting for the next poll interval.
  - **ATLARIX-48, brand-new CLI/app sessions not visible in `list_sessions` until first message** — **FIXED 2026-11-02**
    (`3f2ff11`). The blank-session filter in `src/lib/peers/peers.ts` was narrowed to `surface === "editor"` only.
    CLI and app sessions now appear in `list_sessions` the moment they register, even with zero messages.
  - **ATLARIX-45 "Source folder does not exist"** (`src/ipc/handlers/import_handlers.ts:65`): opening a moved or deleted
    workspace (usually from Recent). The user IS told (`showError` in `src/lib/open-workspace-session.ts:474`), but as
    raw text "[import-app] Error: Source folder does not exist". Ignored forever in Sentry 2026-10-27 at the owner's
    request. Code side: `createLoggedHandler` (`src/ipc/handlers/safe_handle.ts`) sends EVERY IPC error to Sentry;
    mark expected user-condition errors (missing folder, and similar) so they are logged but not reported, show a
    plain message ("That folder no longer exists. It may have been moved or deleted."), and offer to remove it from
    Recent.
- **Add GPT-6.1 Terra to Atlarix Core as a new slot, core-6 (owner, 2026-10-27).** Make it one of the available models
  and selectable in every model picker (app, CLI `/model`, VS Code panel, ACP options). All five slots are taken
  (`routing` in atlarix-releases `core-models.json` has core-1…core-5), so it needs a sixth:
  - App: `CORE_TIER_6` and its env lookup in `src/ipc/shared/compass_constants.ts` (next to `CORE_TIER_5`, line ~285),
    `src/ipc/utils/dev_core_env.ts`, the label row in `src/shared/compass_product_copy.ts`, and `ATLARIX_CORE_MODEL_6`
    in `.github/workflows/release.yml`, `msix.yml` (and every other workflow that lists 1-5).
  - atlarix-releases `core-models.json`: a `core-6` routing entry and its provider (OpenAI); check pricing, context
    window and the API model id against OpenAI's model page first, never from memory.
  - atlarix-proxy: confirm it routes any slot named in `core-models.json` (no hardcoded list), and that billing prices it.
  - Launchpad: the Core lineup is derived from `core-models.json` and CI-checked (`check:core-lineup`); regenerate.
  - Older apps must ignore an unknown slot without breaking; check a 15.11.1 build against the new JSON before
    publishing it.
- **15.11.2 small items:** a reply label shows a prettified raw id for ~10–20 s after launch, until the model list
  loads; a provider renamed by the CLI keeps its old name in an open app until restart (the cached model list).
- **Bun on CI:** `npm run test:bun` runs in the quality job now; the first runs passed. Locally the team uses the same
  command (a plain multi-file `bun test` fails on purpose).
- **The first real deb/rpm auto-update is 15.11.1 → 15.11.2:** check it on a Linux desktop when 15.11.2 ships,
  including the pkexec prompt (unreachable in containers).

## 🔨 Handover 2026-10-24 (ai-27) — 15.11.0 released overnight; what is left

The owner approved the scope 2026-10-23 and asked for a full release overnight. Team notes:
`~/.atlarix-e2e/team/STATUS.md` (newest at the bottom) and `~/.atlarix-e2e/team/MORNING-2026-10-24.md` (the owner's list).

### A. Owner steps

- **GitHub App "Atlarix Cloud Agent" → Permissions:** set Repository "Secrets" and "Variables" to "No access". Nothing
  uses them since the cloud agent went paid-only (reviewer ae7061c, agent-action v1.4.0). GitHub asks for sudo mode,
  so it's yours.
- **VS Code Marketplace:** DONE for 15.11.1 (owner, 2026-10-25; all 8 platforms public). CI publishes Open VSX only,
  so every release still needs this upload by hand.
- **Proxy copies drift on a scripts-only push (2026-10-24).** Every push to atlarix-proxy main redeploys Railway, but the
  AWS copy only moves with `scripts/aws/90-proxy-failover.sh`, so the uptime watcher emailed "proxy copies differ" after a
  one-line change to scripts/aws/60-lambdas.sh. Fix: compare only the deployed code (e.g. a hash of the bundle, not the
  commit), or redeploy the AWS copy from the same CI step that Railway deploys from.
- **Test hygiene (2026-10-24):** bun/vitest runs log into the owner's ~/Library/Logs/Atlarix/main.log (it rotates the real
  app's updater lines away); all bun files share one database (a later file can't get a clean one).
- **Linux notifications:** check on a real GNOME/KDE desktop whether a chat title with `&` or `<` breaks the body on
  markup daemons; escape only if confirmed.
- **Proxy failover: LIVE 2026-10-24.** The AWS copy (us-east-1, commit 2f30852) has its own Supabase key
  `aws_proxy_failover`. `proxy.fallbackUrl` is set in atlarix-releases core-models.json (477f0e4), and the uptime
  watcher checks it (fde2b27). Clients fall back only on no connection / 502 / 503 / 504, never mid-stream. Not yet a
  load-spreader: free-tier counters live in eu-west-1 DynamoDB, and two copies reopen the one-reserve-per-copy gap.

### A2. Found in the 15.11.0 artifact checks (ai-44)

- **Intel Macs never auto-update** (pre-existing, same in v15.10.0): `latest-mac.yml` lists only the arm64 files, so
  electron-updater on x64 has nothing to download and shows only the notify banner. Publish both architectures in
  the mac manifest (or a separate `latest-mac-x64`/arch-aware feed).
- **Windows CLI version resource:** Company/Product/Description/Version now say Atlarix, but bun still fills
  LegalCopyright ("https://bun.com/docs/project/licensing"), InternalName "bun" and an empty OriginalFilename. Set
  them if bun's compile options allow, else post-process the resource.
- **Linux deb:** the computer-use executor needs libxkbcommon0 and libwayland-client0; `Depends` doesn't list them
  (libgtk-3-0 pulls both on Debian/Ubuntu). List them explicitly.

### B. Not verified (say so in any announcement)

- The Windows CLI's file metadata (Atlarix / Amariah Abishai / Atlarix CLI, a37e7e9e) is only written when Bun
  compiles ON Windows, so it can only be seen in the CI-built release exe: check Properties → Details.

- Computer use on **Linux** (X11/Wayland): built and type-checked in CI, never run live. Wayland has no test machine.
- Computer use with a **real** model on the Mac: by rule only a scripted model drives the real keyboard/mouse here.
  The real-model runs happened in the Windows VM.
- ⌃⌥Esc on the pill (unit-tested; QA can't send OS keys) and a real hand moving the mouse (scripted takeover proven).

### C. Railway breach rotation — DONE 2026-10-23; leftovers

Rotated and deployed: proxy (57c91fb), reviewer (4326324), backup; old keys revoked at OpenAI, Kimi, Requesty,
DeepSeek, Z.ai, Lemon Squeezy, Resend, Cloudflare R2 and both GitHub Apps; the old Supabase secret key deleted;
the database password reset; GitHub, Slack and Lemon Squeezy webhook secrets changed; the Slack install's token
re-encrypted under a new `SLACK_TOKEN_KEY`. Teleios Centre Kenya's Postgres was rotated by its own session.

- Discord, VirusTotal, legacy JWT keys, old AWS keys, stale secrets: DONE 2026-10-25 (see the 2026-10-25 handover).
- **Proxy `/health` shows `commit: null`** because it was deployed with `railway up`. Deploy from git next time so
  the SHA shows (the AWS uptime STALE check compares it).
- **Where keys live now:** Supabase secret keys `railway_20261022` (proxy, reviewer), `aws_lambdas_20261022`
  (usage-writer, daily-digest, comp-pro), `edge_functions_20261023` (edge
  `NEXT_PUBLIC_SUPABASE_SECRET_KEY`). Supabase Auth's SMTP password is the new Resend key. Before revoking any key,
  check `supabase secrets list` and the auth SMTP config: the edge functions hold copies.

### D. AWS relief (ai-c4) — live, and what is left

- **Live:** the `atlarix-inbox` Lambda (with `inbox_writer`, INSERT only) and the reviewer's drain; the
  `atlarix-uptime` watcher (every 5 min, emails atlarix-alarms); the three small Lambdas on their own Supabase key.
  The reviewer logs `[trace]` lines; `scripts/aws/trace.sh <delivery key>` follows one delivery.
- **Left:**
  - **The proxy copy is DEPLOYED but must not be used yet:** `atlarix-proxy-failover` (us-east-1) @ 684dbd0
    (= 57c91fb + the adapter; branch `ai-c4/aws-relief` in atlarix-proxy, not merged), at
    https://gbo3uaoxtx2u7aub7npsbtzyua0dlqbi.lambda-url.us-east-1.on.aws/. `/health` and the debit dedupe are proven.
    Its Supabase key was deleted, so it fails closed. Re-mint its keys (`scripts/aws/90-proxy-failover.sh
    --secrets`) before setting item 10's `fallbackUrl`. Either keep its `aws-proxy-copy-2026-10-2x` provider keys
    (OpenAI, Kimi, Requesty, DeepSeek, Z.ai; they live only in its env), or revoke them and re-mint. Merge
    `ai-c4/aws-relief` into the proxy so Railway and the copy run ONE sha, and add the copy to the uptime TARGETS
    in `60-lambdas.sh`. Client rule: fall back on connect failure, 502 or 503 only, never 504.
  - **Webhook URL switch to the inbox** (https://l7k2phhezgchepvhsuuplipzre0uxubo.lambda-url.eu-west-1.on.aws):
    `/github/reviewer`, `/github/agent`, `/slack/events`, `/slack/interactions` (Slack's two switched 2026-10-25;
    the two GitHub Apps are the owner's). The inbox passes end to end with
    the new secrets (stored → claimed → done in ~1 s). The Reviewer App's webhook still points at
    `atlarix-reviewer-production.up.railway.app/webhooks/github`; its secret was missing until 2026-10-23 and is
    set again now. The owner does the App webhook change (a session's classifier refused it).
  - **Backup on AWS:** the `atlarix-backup` Lambda holds the R2 token `atlarix-ledger-backups-aws-2026-10-23` (still
    active; only in its env) and a THROWAWAY `AGE_RECIPIENT`. Set the real recipient before any run. It has no schedule (`PREFIX=rehearsal`, no
    alerts), so it never runs by itself. Still to do: dry-run and apply `backup_reader` + `backup.users_min`, the
    rehearsal restore, 2 overlap nights, then the switch.
  - **STALE check** compares commits only when both are non-null. Set `ATLARIX_COMMIT=<sha>` on Railway at each
    deploy (server.ts reads `RAILWAY_GIT_COMMIT_SHA ?? ATLARIX_COMMIT`).
  - 8 proof rows (`ai-c4-proof-*`, `ai-c4-check-*`) in `public.inbox`: the drain's daily prune removes them after
    7 days.

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
- **Linux: `run_command` can't see the host's /tmp** (ai-b8, 2026-10-22, pre-existing). The bwrap sandbox mounts
  `--tmpfs /tmp`, so `cat /tmp/x` from a command says "No such file" (no denial, no card) unless /tmp is a writable
  root. Owner decision: should the host's /tmp be visible read-only inside the sandbox?
- **`atlarix --version` unpacks the skills cache.** It shouldn't need to.
- **Vercel's git auto-deploy for atlarix-launchpad didn't fire** on 2026-10-21 (two main pushes, no deployment);
  `vercel deploy --prod --yes --scope amariah-kamaus-projects` from a clean tree worked. Check the Git integration.
- **Seen while filming the release video (ai-fc, on the released 15.10.0, not yet verified):** (a) each "New chat"
  click in the VS Code panel adds a "New editor session (<project>)" row to `__atlarix_live_sessions` (~30 rows
  after ~30 clicks), so empty sessions pile up; (b) the panel's Past chats doesn't refresh while open, so a chat
  the CLI starts only appears after it's reopened; (c) `glob` (`Find *`) in the memory folder, under a hidden
  path (`~/.atlarix-e2e/…`), returned "no files" right after a note was written there — the glob may skip
  hidden-path dirs (ripgrep's hidden-file default?). Reproduce on a scratch profile first.
- **Store uploads by hand:** the 8 `.vsix` at marketplace.visualstudio.com/manage/publishers/atlarix. winget is
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

- **VS Code: nothing by hand.** Both marketplaces publish on the tag (OIDC to the VS Code Marketplace, `OVSX_PAT` to
  Open VSX); check both listings show the new version.
- **Microsoft Store: nothing has published since 14.51.0 (2026-09-23).** Microsoft DENIED `unvirtualizedResources`
  twice (reports 2026-09-28 and 2026-10-07, "10.6.3 Capabilities"): the package switched off registry
  virtualization for all of HKCU, and the notes didn't justify it. Then 82a24426 replaced every submission still in
  certification, so each release restarted the days-long review. Fixed on dev (2026-10-23, ai-27): the manifest
  excludes only the five bridge keys (Windows 11 flexible virtualization; no Windows 10 fallback), the
  certification notes answer every point of the report, and the script waits on a submission being processed or
  certified instead of replacing it, and REUSES a draft (so hand edits on it survive). Done in Partner Center
  2026-10-23: submission 32 (15.10.0, old manifest) certification CANCELLED on the owner's order, so it is a draft;
  its Properties → Support info now has website `https://www.atlarix.dev` and contact `support@atlarix.dev`. Left:
  - **The next Store submission must reuse draft 32** (the script does that now) and carry the fixed manifest. It
    goes with the 15.11 release, unless the owner wants a Store-only build sooner.

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

### Permission reason on command approvals (owner, 2026-11-06; branch team/permission-reason, UNMERGED: owner reviews the wording)

- Built: run_command's optional `reason` (a question to the user, like Codex's `justification`) is shown as
  "Reason: …" above the command on the app card, the CLI card, the VS Code bar and ACP (first line of the note, plus
  `_meta.atlarix.approval.reason`), and as `reason:` in a peer's `pending_of`. It is cleaned once
  (`approval-reason.ts`: one line, no control characters, 200 chars) and never replaces the command.
- Costs 39 prompt tokens where run_command is bound (603 → 642, o200k), plus about 13 output tokens on each call
  that fills it.
- Not done, on purpose: the Chrome panel (no run_command; its tools keep Claude-in-Chrome shapes), MCP calls (their
  schemas are the server's), file edits (the diff is the case). Sandbox-escalation cards keep their own question.
- To check once merged: how often current models fill it, and whether it reads as a question.

### 0. Computer use: permission prompts that say "Atlarix" everywhere (owner, 2026-10-24: after 15.11)

- **Mac:** the desktop app's prompt already says Atlarix. From the CLI and editors, macOS names the RESPONSIBLE app
  (Terminal / iTerm / Visual Studio Code / Zed). Fix: ship `atlarix-computer` as its own small signed app bundle
  ("Atlarix", fixed bundle id, Developer ID G2, a signature that never changes) and launch it so it is its own
  responsible process. One grant then covers every surface and survives updates. Getting the identity wrong
  re-asks for the grant after every update; that's why it isn't in 15.11 (ai-fc, 2026-10-23).
- **Linux Wayland:** register Atlarix's app id (a `.desktop` file; the portal Registry for the CLI) so the
  screen-share / remote-desktop dialog says Atlarix. Untested live (no Wayland machine here).
- **Windows / Linux X11:** no OS prompt exists; add a one-time Atlarix "Allow Atlarix to control your screen?"
  confirmation when the switch is first turned on.
- **15.11 already ships:** the warning on every surface before macOS asks ("macOS will ask to let <app> record the
  screen and control the computer. That's Atlarix's computer use.") + the responsible app's name in permission errors.


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

### 10. ~~Paste duplicates text when copying from own message~~ — CLOSED 2026-11-02: not a bug

Investigated. The "[Pasted text #N +L lines]" chip is the CLI composer's intended collapse of a 3+ line
paste, not a doubled paste: both handlers call `preventDefault()` when they capture the paste (CLI
`src/cli/tui/Composer.tsx`; app `src/hooks/useAttachments.ts`), so the raw text is never also inserted
inline, and the app's attachment merge dedupes by content key. No reproduction. Regression test added:
`src/__tests__/renderer/attachments-paste-preventdefault.test.tsx`.

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

- **GitHub Marketplace — under review again (2026-11-04).** GitHub reviewed it on 11-04 and asked for a support
  link and working optional links; Atlarix fixed the listing (`/support`, `/status`, `/reviewer`) and re-submitted
  the same day. Wait for marketplace@github.com. **Do not touch "Withdraw request".**
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
- **NEXT for the Auto router (owner, 2026-10-24): Pro only, and only if it's small.** Order:
  1. Outcome logging for every paid Auto step: kept going, no retry, no model switch, tools didn't fail.
  2. Two candidates in `shadow` (they log their pick next to the table's, they don't decide):
     - option 5, the on-device contextual bandit (no model, a few KB);
     - a cheap hosted classifier call (a Groq-hosted small model, or Claude Haiku) as the "model as router" baseline.
     Hugging Face's RouteLLM routers (BERT / matrix factorisation, lm-sys/RouteLLM) are free but trained on
     GPT-4 vs Mixtral, so they'd need retraining on our traffic first.
  3. Compare cost + outcomes, then let the winner decide, for Pro only.
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
