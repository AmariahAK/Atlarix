# Atlarix TODO

**Unreleased on `main`, untagged:** the realtime scaffolding v14.38.2 left behind is deleted
(~150 lines that could not run — `realtimeCleanup` is never assigned, so `pauseRealtime()` was
a permanent no-op), and the README stops claiming four Core models. Owner green-lights the
release; nothing is tagged. Out-of-band the same day, needing no app release:
Core 1 -> **GLM 5.3** (`atlarix-releases@0db87cb`, identical pricing to 5.2 so the metering
maths does not move), the reviewer's idle poll 120/hr -> ~15/hr, the reviewer security pass,
and the proxy's service-path account check.

**Current version:** v14.38.2 — **SHIPPING 2026-08-27.** The Settings → Integrations fix,
the doc corrections, the connected-repositories list, the navbar label, and the realtime
teardown: the always-open plan-change channel was 93.5% of database execution time and is
replaced by a read on window focus — which also fixes the upgrade flow the old handler
missed entirely (it only refreshed after a 60s idle-out).

**Previous:** v14.38.0 (2026-08-27) · v14.37.0 (2026-08-24) · v14.36.0 (2026-08-22) ·
v14.35.0 (2026-08-20). Full narrative for every one of them is in
[`CHANGELOG.md`](./CHANGELOG.md).

**Last updated:** 2026-08-28

> **What belongs here:** open work, decisions still owed, and traps worth not
> rediscovering.
> **What does not:** shipped narrative → [`CHANGELOG.md`](./CHANGELOG.md). Design prose →
> [`DESIGN_NOTES.md`](./DESIGN_NOTES.md).
>
> **KEEP THIS FILE LEAN.** It reached 1,811 lines on 2026-08-27 by accumulating a full
> per-release SHIPPED section every version plus the narrative of incidents that had since
> been resolved — all of it duplicated in the changelog or the git history. A queue nobody
> can scan is a queue nobody reads. When a release ships: keep only what changes how the
> NEXT change is made, move the rest, and delete a resolved incident once its lesson is in
> **Traps**.


---

## 🚀 Shipped — v14.38.1 and v14.38.0 (2026-08-27)

Narrative lives in [`CHANGELOG.md`](./CHANGELOG.md); the durable lessons are in
**Traps worth not rediscovering** below. What is kept here is only what changes how the
NEXT change is made.

- **`billing_copy.ts` forbids printing the allowance in dollars, and v14.38.0 broke that
  rule in the first thing that ever rendered the number.** A module-level rule is not
  enforcement. When a new field reaches a new surface, re-read the rule that governs it.
  Corollaries now in the code: `<1% used` never `0% used` once anything is spent, and a
  meter fill needs a visible minimum or a sub-pixel bar reads as untouched.
- **Per-product ALLOWANCE is real; per-product CREDIT is not.** `credit_grants` is one row
  per `(user, product)`. `credit_wallet` is a SINGLE shared balance and `spend_from_wallet`
  deliberately lets one product's allowance pay for the other — so the honest per-product
  number is **spend**, from the ledger's `source` column. Do not add a per-product balance.
- **`get_credit_breakdown` is a SECOND RPC on purpose.** `get_credit_balance` is on the
  proxy's hot path before every request and must stay one cheap row.
- **Two startup bugs, and the write-up here had the second cause WRONG.** `--doctor` does
  await `whenReady`; it never called `initializeDatabase()`. Separately,
  `resolveSystemPath()` reads settings at module scope and trips `safeStorage` before ready.
  Two independent bugs printing in one report — see Traps.
- **The launchpad missed v14.38.0 entirely** (`package.json` at 14.37.0, changelog topped
  out there), so v14.38.1 owed the site TWO changelog sections. The three manual launchpad
  edits remain the step that actually gets skipped.


## 🔜 Next session — the queue, in order

### 1. Connected repositories — SHIPPED 2026-08-27

`atlarix-reviewer@09f6ff3` + migration `20260827180000`. The covered set is recorded
from the webhooks that always carried it and the account page lists it. See 1b for why
existing installs still read empty.

### 1b. The repository list is live but the EXISTING installs are empty

Shipped 2026-08-27 (`atlarix-reviewer@09f6ff3`, migration `20260827180000`). Verified in
production: the column exists, the RPC is service-role gated, and both live installs read
`repo_count: 0`.

**That zero is correct and expected — and it will not fix itself.** The list is populated
by `installation` / `installation_repositories` webhooks, and both existing installs were
created BEFORE the code that records them. `installation_repositories.added` is a DELTA,
so nothing replays history.

Until then the account page falls back to the old "selected repositories" wording, which
is the honest thing for it to say. Two ways out:
- **Trivial:** add or remove one repository in the GitHub App's install settings. That
  fires the event and the list fills for that install.
- **Proper, if it ever matters at scale:** a one-time backfill calling
  `GET /installation/repositories` per install with an installation token and applying it
  with `mode: 'set'`. Needs the App private key, which lives in Railway, not locally.

### 1c. Supabase load — CLOSED 2026-08-28. Both polls are gone.

Realtime first (v14.38.2), then the one underneath it. Cumulative
`realtime.list_changes` went 7,323,466 -> 7,324,770 in a day: the fire is out and the 93.5%
still on the dashboard is history, because `pg_stat_statements` has not been reset since
2026-01-14.

**What was left was the REVIEWER, and its own comment undercounted it by 2x.** The
`IDLE_POLL_MS` note said "`claim()` is one PostgREST select". The idle path is TWO —
`reclaimStale()` runs whenever `claim()` comes back empty, which on an empty queue is every
tick. Measured three times, longest window 600s: **2.00 calls/min, 120/hour**, forever,
against a `review_jobs` table that has held **seven jobs in its lifetime**. Fixed in
`atlarix-reviewer@5db86b4`: 5-minute interval, reclaim every 4th idle pass (STALE_CLAIM_MS is
20 min, so that cadence loses nothing). **120/hr -> ~15/hr.**

**The measurement trap, for next time.** `pg_stat_statements` has NO per-request counter.
`select set_config('search_path'...)` looks like one and is not — it fires per CONNECTION, and
PostgREST pools, so it did not move at all across a 600s window in which 20 REST queries ran.
The numerator is measurable this way; the denominator is not. For "what fraction of our
traffic is X" the only honest source is the dashboard's **Logs Explorer on `edge_logs`,
grouped by `request.path`** — which needs a Management API token the CLI keeps in the login
keychain.

**Still open, and still the biggest risk here: `LAST BACKUP: No backups`.** Confirmed again
2026-08-28 via `supabase backups list` — `pitr_enabled: false`, `backups: []` — on the project
holding `credit_wallet`, `credit_grants` and the append-only `credit_transactions` ledger.
Owner chose Cloudflare R2; see the backup section.

### 2. Cut v14.38.2 — DONE 2026-08-27

`0a6e8e2e` is on `main` and untagged. Standard flow: changelog heading FIRST (the awk in
`extract-changelog.sh` must match, or the body silently degrades to a download list), local
gate incl. `check:sandbox`, push, flip the repo public, tag, wait green, flip back private.

### 2b. Money-DB backups — IN PROGRESS 2026-08-28, blocked on the owner

Owner chose **Cloudflare R2** over a Supabase Pro upgrade. What is owed by them, because none
of it can be done from here: a personal Cloudflare account (**R2 requires a card on file even
on the free tier** — usage stays $0 inside 10 GB / 1M Class A / 10M Class B, and a nightly
ledger dump is single-digit MB), a bucket, a bucket-scoped Object Read & Write token, the
Supabase **session-pooler** URI on **port 5432** (transaction mode on 6543 does not work with
`pg_dump`), and an `age` keypair whose PUBLIC half is all the service ever sees.

Shape agreed: a separate `atlarix-backup` repo on its own Railway cron service, `postgres:17-alpine`
(the server is **17.6**; a mismatched `pg_dump` refuses), `pg_dump --schema=public` PLUS a
data-only dump of `auth.users` — credit rows key on `auth.users.id`, so without it a restore
cannot map wallets to people. **Deliberately NOT inside `atlarix-reviewer`:** that process
ingests pull-request text written by strangers, and a full Postgres connection string is
exactly what `atlarix-proxy/src/entitlement.ts`'s header warns against putting there.

**A restore rehearsal is part of the work, not a follow-up.** A backup that has never been
restored is not a backup.

### 3. One non-owner run of the reviewer, end to end

**No account other than `AmariahAK` has ever completed install → subscribe → bind →
review.** `review_jobs` totals 4 (3 done, 1 failed), all owner; `atlarix-releases` is
owner-owned, so testing there exercises the PERMITTED path, not the stranger path. The App
is confirmed **public** as of 2026-08-27, so the route is open — it has simply never been
walked. One second GitHub account settles it, and onboarding bugs live exactly here.

---

## 🔬 Reference sweep — read 2026-08-21, ALL of it landed

Read against `claude-code` v2.1.238, `opencode` dev @ 57fa34f2 and `openai/codex`
rust-v0.149.0. Every item shipped; the per-item accounting is in the changelog. Kept
only for the standing lessons, which apply to the next sweep:

- **A changelog line from another harness is a QUERY, not a task.** Three of ~40 candidate lines
  turned out to describe real defects here; the rest did not apply, and one (opencode having to learn
  that `finish: "unknown"` must not end the loop) we already handled better. Read their fix, then go
  looking in your own source — do not port the fix.
- **Check reachability before repairing.** The multi-file approval card was a genuine grant/display
  mismatch AND unreachable, so the correct response was deletion, not a fix. `git grep` finds
  presence; tracing the producers finds reachability.
- **An error can arrive as a success.** A 200 response, a well-formed stream, and `finish_reason:
  "network_error"` — nothing throws, so every retry path stays disarmed and the turn truncates in
  silence. When a provider hands you a field you never read, ask what it can say.
- **Windows path spellings are a security surface, not a formatting detail.** `path.isAbsolute` is
  `true` for `\\host\share` on Windows, and the relative branch has rejected UNC for years while the
  absolute branch — the spelling an attacker would use — does not. The guard written for this was
  removed on the owner's call (see the decision record above); the observation stands, and any future
  read-deny work inherits it.
## 💵 Pricing — SETTLED 2026-08-26, and the code that implements it

> Owner decisions, recorded so they are not re-argued. The reframe's rule survives intact: **never
> ship a tier whose fee is fully consumed by bundled inference.** What changed is that the fee now
> includes *some* inference, because the old shape asked for two purchases before a new user's first
> agent turn — and that is where the funnel was dying. 108 users at the time of this decision.

- **Atlarix Pro stays $19/mo** and now includes a **$10 monthly Core allowance**, PAYG on top. Price
  deliberately unchanged: $19 was picked to sit under Cursor/Windsurf at $20, and raising it in the
  same breath as improving it turns a clear win into an ambiguous one. **If more revenue per user is
  wanted, the lever is the allowance size, not the sticker** — the sticker is what people compare.
- **The maths, so the allowance is never resized by feel.** $19 less LemonSqueezy's ~7.5% nets
  ~$17.58. $10 of allowance is metered at +40%, so it buys ~$7.14 of real inference: **~59% margin if
  a subscriber spends every cent**, higher in practice because most do not. That breakage IS the
  business. $13 would be 44%, $15 would be 36%.
- **Do NOT publish the $10 figure.** Say "includes Core for everyday work". Denominating an allowance
  in dollars publishes your cost structure and invites the $19-for-$10 comparison; nobody else in the
  market does it.
- **Atlarix Reviewer is $19/dev/mo, unlimited repos, OSS free.** Per developer is what the whole
  market does (CodeRabbit ~$24 Pro, Greptile ~$30, Bugbot ~$40) and **nobody charges per repo** —
  per-repo punishes microservice teams, who have the most PRs and the most to gain, and creates an
  incentive to install on one repo and skip the rest. It is also safe: a dev's PR output is bounded by
  being human (~10/month regardless of repo count), so unlimited repos costs nothing.
- **v1 is one subscription per bound installation account, not a seat count.** `github_installs`
  already ties an installation to exactly one account, so this needs no seat detection, no LS quantity
  API and no reconciliation job. Seats become an upgrade when a team asks for one invoice.
- **Pro and Reviewer are separate products** — different buyers, different units, and bundling gives
  away the second to someone who already wanted both (spec §10 says the same from the product side).
  Link them with a discount, not inclusion.
- **The two are billed through ONE wallet**, and that is what the `credit_grants` table below exists
  for.

**Built 2026-08-26, APPLIED AND DEPLOYED (verified 2026-08-27):**

> `supabase migration list --linked` shows `20260826130000` / `140000` / `150000` with local ==
> remote on `oubgrpkqyyjwytspycpd`; `supabase functions list` shows `bind-github-install` ACTIVE v1,
> `create-checkout` v26, `cancel-subscription` v25 and `handle-lemon-webhook` **v43 with
> `verify_jwt: false`** — the one setting a deploy can silently re-arm, checked and correct.
> The launchpad `/login` → `/reviewer/setup` → `/account` pages shipped the same day.

- `supabase/migrations/20260826130000_subscription_credit_grants.sql` — `credit_grants`
  (one row per user × product), `spend_from_wallet`, `wallet_spendable`,
  `grant_monthly_credit_service`, `clear_monthly_grant_service`, and grant-first rewrites of
  `debit_wallet` / `debit_wallet_service` / both balance reads.
- `supabase/migrations/20260826140000_reviewer_subscriptions.sql` — `reviewer_subscriptions`,
  `upsert_reviewer_subscription_service`, `reviewer_entitlement_service`, and `not_subscribed` added
  to `review_history`'s CHECK.
- `create-checkout` gained a `mode: "reviewer"`; `handle-lemon-webhook` gained
  `subscription_payment_success`, product classification, and allowance grant/clear on both products.
- Reviewer repo: an entitlement gate ahead of the wallet check, `last_error` cleared on success, and
  `installation_repositories` no longer confusable with an install removal.

**Traps found while building it, worth not rediscovering:**

- **`balance_cents` in every RPC result now means SPENDABLE total** (allowances + purchased), not the
  purchased column. That is what makes the change need no client edits: the proxy's pre-flight gate,
  the app's balance display, `--doctor` and the low-balance nudge all read that one key through an
  RPC, and nothing anywhere reads `credit_wallet` directly. Verified across all three repos before
  relying on it.
- **An allowance is SET, not added, so `(kind, ref)` idempotency cannot protect it.** That index makes
  repeated INSERTs safe, which assumes deltas add up. A replayed grant has to be refused *before* any
  arithmetic — hence `credit_grants.ref`, checked first.
- **One `granted_cents` column cannot serve two products.** With SET semantics, whichever subscription
  renews second silently wipes the other's allowance. Caught while wiring the reviewer, before it
  shipped; the per-(user, product) row makes it structurally impossible.
- **`users.plan` could not hold the reviewer entitlement.** `users_plan_check` and
  `users_effective_tier_check` pin it to ('free','pro'), and the same pair is typed in five more
  places. But the real reason is that Reviewer is not a rung on that ladder — it is held with Pro,
  without Pro, or alone — so a tier column would force a fake ordering.
- **`subscription_payment_success` carries a different payload shape.** Its object is an INVOICE, so
  `event.data.id` is the invoice id and the subscription comes from
  `attributes.subscription_id`. The `subscriptionId` every other case uses is the wrong value here.
  The invoice id turns out to be the ideal per-period grant ref.
- **A missing `switch` case is completely silent.** `default:` logs and 200-ACKs, which is right for
  LemonSqueezy (a 4xx retries forever) and is exactly why the absent
  `subscription_payment_success` branch went unnoticed while the event was already subscribed on the
  LS side. If a paid behaviour does not fire, look for a missing case first.
- **`review_history.kind` is CHECK-constrained**, so the worker's new `not_subscribed` outcome needed
  the constraint widened or the insert would have raised 23514 on a path whose whole job is to decline
  quietly.

**How to apply the NEXT one, because this is not `db push`.** The local migration history is not in
sync with hosted, so migrations go through the SQL editor and `supabase migration list --linked` is
how you confirm one landed. **Re-check `verify_jwt` on `handle-lemon-webhook` after every deploy** —
`supabase/config.toml` declares no `[functions.*]` section, so that setting lives only in the
dashboard and a deploy can re-enable it, which would break every webhook (LemonSqueezy sends no JWT).

**Refunds shipped in v14.38.0** and there is no longer a refund section below. Kept as a pointer because this paragraph is where someone reading the credit-grant work will look for it: the traps are in the shipped index, and `refund_grant_service` is the fifth service RPC.

---

## ✅ Verification owed — code done, no code expected

These are trips and clicks, not tasks. Each fix is already shipped.

- [ ] **Does the memory move actually change behaviour?** Re-run the same "how've you been / what's in
      memory" prompt on `wisdom-drop` with DeepSeek V4 Pro and count tool calls. Baseline is the
      logged session: ~15 calls, ending on a stale backup. A pass is reading the store directly. **If
      it still hunts, placement was not the answer** — the honest next step is a memory tool, not more
      prompt, and this item should say so rather than being quietly ticked.
      Note `~/.atlarix-memory-backup-2026-08-19/` is a HAND-MADE copy (nothing in our source creates
      it) whose content differs from live; it will keep winning `find` races while it sits in `~`, so
      move it before drawing conclusions from a re-run.

- [ ] **The unreleased batch, in the PACKAGED app** (never the dev server): two sessions with
      different modes following their own session; switching away from a large session and back with
      no empty chat; a turn in A surviving a switch to B; every Diagnostics row rendering,
      "Copy report" carrying no key material, and `--doctor` exiting.
      **This machine cannot do it as-is:** the root `better_sqlite3.node` is dated Jun 15 and was
      never rebuilt for Electron 43, so a raw `npx electron .` dies with
      `NODE_MODULE_VERSION 141` vs `148`. `npm start` / packaging runs Forge's electron-rebuild and
      heals it — but that also means a raw-binary launch is not a valid way to test anything here.
- [ ] **The session-load numbers** — `ATLARIX_DIAG_SESSION_LOAD=1` (main) +
      `localStorage["atlarix:diag:session-load"]="1"` (renderer) on the 1.43M-token session, four
      numbers recorded. NOT closed by the cold-chat eviction that shipped: eviction frees memory
      AFTER the fact and cannot make the first `parseDisplaySnapshot` cheaper. Whether the parse or
      the main→renderer transfer dominates is what decides where laziness goes, and it is a
      measurement, not a guess.

- [ ] **Anthropic extended thinking — BELIEVED fixed, not OBSERVED fixed.** The capability branch,
      the SDK-shaped `budgetTokens` and the temperature omission are covered by 12 tests (verified
      sensitive), but there is no Anthropic key here and the failure mode is a provider-side **400**,
      so the request has never been sent. **The check:** one reasoning prompt on a Claude model with
      a real BYOK key — no 400, and thinking parts stream. If it 400s, suspect temperature:
      Anthropic accepts only `1` with thinking on and `getTemperature` defaults to `0`, which is
      exactly why `shouldOmitTemperature` exists.
- [ ] **Whisper-worker dictation under the new CSP.** The worker only spawns when a composer mounts
      with the local provider, so it needs a workspace open. Confirm dictation still transcribes and
      the log carries `[csp] APPLY resourceType=script … whisper-worker`. If ONNX fails to compile,
      revert to docstring-only — a blocked worker that also blocks WASM is worse than the gap.
- [ ] **`read_url` through a real turn** against a JS-rendered SPA and a bot-walled page. The
      mechanism is measured (excalidraw 69 → 722 chars, g2.com 0 → 251, five parallel fetches 624ms);
      what is untested is the path through the packaged app's own tool.
- [ ] **Drive a passkey sign-in by hand in the packaged browser** — a security key, and the
      "use a phone or tablet" QR flow. This is now the WHOLE passkey story (the device-stored
      authenticator is gone, below), so it is promoted from a fallback check to the first thing to
      verify. Success is a completed sign-in; failure is the notice firing when it should not, or a
      roaming request being reported as unsupported.
- [ ] **CI must resolve the win32 + linux TypeScript 7 platform binaries.** Only darwin-arm64 is
      proven.
- [ ] **Confirm `[prompt-cache]` still shows a large `read=` on later turns in a mode.** A `write=`
      that jumps every turn would mean the per-mode tool-description tiering is invalidating the
      cached prefix.

## 🚧 Needs the Windows machine — one trip clears all of it

**Every fix below is ALREADY SHIPPED.** This is a verification checklist. Counting it as a backlog is
what made this queue read three times its real size.

> **The migration itself is VERIFIED (2026-08-21).** A full end-to-end pass ran on **Windows and
> Linux** against the packaged v14.35.0 build and the app works: it installs, launches, and runs a
> real turn after the Electron 43 upgrade and the AI-SDK spec-line majors. That closes the question
> the migration actually raised — whether a native ABI or a provider spec change broke a platform no
> one develops on — and it is the first time both platforms have been confirmed on a release of this
> size. What survives below is not "does it run" but the individual behaviours whose only evidence is
> a specific log line or a specific click, which a smoke pass does not produce. Tick them as they are
> observed rather than assuming this pass covered them.

- [x] **Electron 43** — verified 2026-08-21 on Windows and Linux: the packaged app runs after the
      upgrade. Still worth capturing if you are back on the machine anyway:
      `self-test:packaged` reporting **9 probes** including the new `sqlite` one (the only genuinely
      ABI-pinned module, and the one nothing used to cover). The upgrade does **not** revalidate the
      sandbox helpers — standalone Rust binaries, no Node ABI coupling — but they need this machine
      anyway, below.
- [ ] **Passkey notice ACCURACY** — it must **not** appear for a request that explicitly asks for a
      roaming authenticator, because a security key or a phone over hybrid/QR works on every
      platform. Verify one actually does.
- [ ] **Windows sandbox (Low IL, v14.28.0)** — `run_command` must succeed with git under Low IL;
      that is the whole point. Confirm an **info**-level `Sandboxing run_command` line (it was
      `debug`, so only failure was ever visible). `CreateProcessAsUserW` must succeed unprivileged —
      `ERROR_PRIVILEGE_NOT_HELD (1314)` means commands run unconfined, and then implement Codex's model.
- [x] **Process-tree kill (v14.32.0)** — VERIFIED by the owner on Windows and Linux, 2026-08-21.
      `taskkill /pid <pid> /T /F` reaps the tree; it was previously reasoned from documented behaviour
      only, with the real-process test skipped on Windows.
- [x] **On-device voice (v14.30.0)** — VERIFIED by the owner on Windows and Linux, 2026-08-21.
      Dictation works after the q4 fix, which closes the item the v14.30.0 release opened with
      "Windows+Linux runtime verification still owed".
- [ ] **MSIX §4 behaviour check** (`MSIX_RUNBOOK.md`) — **baseline on Squirrel FIRST**, or a failure
      inside MSIX is unattributable. Plus: the manifest protocol declaration works for OAuth, and
      `atlarix://pro-return` completes a Lemon Squeezy purchase. Not to be confused with the packaging
      spike, which ran 2026-08-07. A Squirrel → Store reinstall **keeps user data** (verified by hand
      2026-08-12, so no migration is needed); the exact `userData` path string is the one piece still
      unrecorded.
- [ ] **Linux, not Windows: the notification SIGSEGV** in
      `electron::NotificationPresenter::RemoveNotification` (Fedora 44 Sentry report). Fix is
      reasoned, not observed. Leave the app unfocused through several automation runs and let
      notifications expire rather than clicking them; success is a clean Sentry week.
- [ ] Linux voice, never tested, now on the same WebGPU-first path.

## 🩺 Atlarix Core: one 12s timeout, not reproducible

Seen once on the first `--doctor` after packaging v14.38.0, then 1.7s on the next
run. Cold session refresh, most likely. Worth a second look only if it recurs on a
warm run. (Separately: three Core 503s on 2026-08-27 — watched, not diagnosed.)

---

## ⚠️ Known and NOT fixed — deliberately, with reasons

- **Windows: the packaged app does not exit after `--self-test`. ROOT CAUSE UNIDENTIFIED.** It prints
  `PASSED (9/9 probes)` and then keeps running until something kills it. A SECOND process boots the
  app for real — `db-migrate` applying migrations, the Squirrel updater (`Can not find Squirrel`),
  automations, Supabase, the budget fetch — which is only possible with `IS_SELF_TEST` false, so it is
  not the process the runner launched. **This is NOT new:** the identical second-process boot appears
  in the v14.35.0 Windows log, which SUCCEEDED, so the boot is long-standing and something else
  regressed between 08-20 and 08-22. Ruled out by reading the code: the `proxy-worker` probe uses a
  `worker_threads` Worker (in-process, and it terminates it), nothing calls `app.relaunch()` or
  re-executes `process.execPath` on this path, and the v14.36.0 `main.ts` changes are all behind
  `IS_SELF_TEST` guards that provably still short-circuit. Not reproducible on macOS.
  **Mitigated, not fixed** (v14.36.0): `run-packaged-self-test.mjs` now takes its verdict from the
  probe REPORT in the file sink rather than from process termination, kills the process tree, and
  prints a loud warning. A failing probe, a launch error, a signal kill, a non-zero exit, or no report
  at all still fail the build — only "everything passed but it would not exit" is downgraded. It cost
  two full release runs before that change.
  **Where to look next:** a Windows machine, `atlarix.exe --self-test` from a terminal, and Process
  Explorer to see what the parent of the second process actually is. That single observation is worth
  more than any further code reading.

- **`withLock` serialises TWO callers, not N.** `src/ipc/utils/lock_utils.ts` awaits only the one
  lock it observed, so with three contenders B and C both wake on A's release and **both acquire** —
  C's `locks.set` overwrites B's. Correct for two callers, silently not a mutex beyond that. Found
  while fixing the plan lost-update race, which is why plan writes use their own FIFO chain
  (`withPlanArtifactLock`). Its callers are app-lifecycle paths; whether they ever see three
  concurrent callers is the open question. Changing shared locking semantics deserves its own pass.
- **A `DatabaseClosingError` escapes as an unhandled rejection.** Three boot tasks catch it and log
  "non-fatal"; one leaves a floating promise, so it reaches Sentry as `handled = no` and pages the
  owner. The guard is right; one boot task needs a `.catch`. Any user who quits during startup can
  hit it.
- **Local packaged builds report `environment=production` to Sentry — KEEP, decided 2026-08-22.**
  `app.isPackaged` is true for a local ad-hoc build, so a developer machine reports as production.
  That was filed here as a defect with a fix attached (gate the DSN on a CI marker or the signing
  identity); the owner's call is to leave it, because local packaged builds are a deliberate
  diagnostic channel — some bugs are only findable through Sentry, and separating the environment
  would put exactly those runs where nobody looks. **This is settled, not pending.** The cost is
  accepted: production alert counts include the owner's own machine, so never read alert VOLUME as a
  user-impact signal without checking the source first.
- **`useAuth` is an UNSHARED hook with ~22 consumers**, each running its own `checkSession()` —
  still the cause of repeated "Enforcing workspace limit" logs. Guard in the IPC handler, never in
  the hook. **The sign-out half is now scoped:** `SubscriptionManager.signOut()` does not broadcast
  `auth:resolved`, so only the instance that initiated a sign-out updates and a second window keeps
  a stale session. `broadcastAuthResolved()` already has no null-session guard (deliberately — that
  guard *was* the bug), so the fix is one call plus making `handleAuthResolved` clear `user`/`status`
  on a null user instead of early-returning. Do it with the rest of the unshared-hook work.
- **vite 8 warns that `configLoader: 'native'` will become the default** — `vitest.config.ts` uses
  ESM syntax while loaded as CommonJS. Harmless today, fatal when the default flips. The fix (`.mjs`
  or `"type": "module"`) changes how every config in the repo loads, so it wants its own change.
- **`ai@7`'s `instructions` placement is the aligned end state, not done.** `role:"system"` inside
  `messages` is re-permitted with `allowSystemInMessages: true` so the v10.1 prompt-cache layout
  stays byte-identical and measurable. Moving it into `instructions` (which accepts
  `Array<SystemModelMessage>`, so breakpoints could survive) needs its own commit and its own
  `[prompt-cache] read=` measurement.
- **`drizzle-kit` stays at 0.30.6** while `drizzle-orm` is 0.45.2. **Bump it before the next schema
  change**, or `db:generate` runs against a mismatched pair.
- **Accepted advisories, with reasons rather than a shrug.**
  `@huggingface/transformers` → `onnxruntime-node` → `adm-zip` → `sharp` has no fix and is the
  deliberately-pinned voice stack. `shepherd.js` → `deepmerge-ts` (stack exhaustion on recursive
  merges) needs a major; the call site was checked rather than assumed — tour options are static
  literals in `TourManager.tsx`, so no attacker- or model-controlled object reaches the merge.

## 🔜 Blocked on the owner — not active work

- **Windows code-signing cert** — C6 auto-update signing + native-sandbox CI. Release infra, no cert.
  The Windows helper sign step is wired; set the secret to enable.
- **Atlarix GitHub account** for contributor credit (owner action; code done).
- OAuth `state` nonce / PKCE stays **not doing** — attempted v14.12.0, broke sign-in, reverted. The
  flow-in-progress gate stays. Revisiting needs confirmation that the Supabase redirect-URL
  allowlist permits a query param.

## 🔐 Security — the REVIEWER is done (2026-08-28). The rest of the topology is not.

Owner scoped the pass to **`atlarix-reviewer` only**, audited by hand. Five findings, all
five fixed in `atlarix-reviewer@edc457e`. **The write-up lives at
`../SECURITY_AUDIT_reviewer_2026-08-28.md` — OUTSIDE every repository, on purpose:** the
reviewer and proxy repos get flipped public to run CI past the Actions budget block, so a
repo whose visibility toggles is not a home for a live exploit write-up. That is a general
rule now, not a one-off.

**The two that mattered, kept here because they are lessons, not history:**

- **A comment claiming a boundary is not a boundary.** `tools.ts` said there was "no way to
  read outside the repository under review". `fileAt` built its URL with `encodeURI`, which
  leaves `/` `.` `?` `#` alone **by design** — it encodes a URL, not a path segment — and
  `fetch` normalises dot segments like any URL parser. `../../../<org>/<private>/contents/.env`
  reached that file with the installation token attached, and the review is posted as a PUBLIC
  comment, so read and exfiltrate were the same action. **When a comment asserts containment,
  go and try the thing it says is impossible.**
- **Ask who is allowed to spend, not just who is allowed to speak.** An `@atlarixagent`
  mention re-runs a paid review, and the only filter was "not a bot" — so on a public repo any
  GitHub account could drain a paying customer's wallet by commenting in a loop. The fix was
  already in the payload: `author_association`. **`CONTRIBUTOR` is deliberately NOT in the
  allowed set** — on a public repo that status is earned by one merged PR and never expires,
  which makes it a permanent licence to spend someone else's money.
- Two smaller ones worth the habit: untrusted blocks could close their own delimiters (fixed
  with a per-prompt nonce — the attacker writes their text before the nonce exists), and
  installation tokens were minted for the WHOLE installation when a review needs one repo.

**Still NOT audited, and unchanged since the ask:** `handle-lemon-webhook` downstream of a
valid signature (replayed refunds, forged `custom_data.supabase_user_id`, an invoice id reused
as a ref across accounts), `bind-github-install`'s one uncovered layer (a VALID code from an
account that does not administer the target), and the **secrets inventory across four
deployment targets** with no rotation story — the App private key being the worst, since it
authenticates as the bot to every installation.

**Closed by this pass:** the proxy's service path no longer takes `x-atlarix-account-id` on
trust (`atlarix-proxy@1fae9a0`), so a leaked `REVIEWER_SERVICE_TOKEN` reaches only accounts
that actually installed the App. Verified read-only and NOT to be re-litigated: all ten
`*_service` DEFINER RPCs are `service_role`-only, RLS is on for all ten public tables, and
`review_jobs` has RLS with zero policies (deny-all except service_role, correct by design).

## 📚 The docs are stale — owner's ask, 2026-08-27

> Same class of problem the pricing copy had, and found the same way: the site said Pro was
> pay-as-you-go while the account page said Pro included Core, and both shipped.

- **The pricing framing is now DONE across both repos — verified 2026-08-27, not assumed.**
  `grep` for `no plan bundles AI` / `Both Free and Pro pay the same way` returns nothing in
  `guideDocs.ts`, `helpDocs.ts`, `PricingTiers.tsx` or `PricingPage.tsx`. The app repo's
  `README.md` and `docs/compass-limits.md` carried the same stale claim and were corrected in
  `0a6e8e2e`; `Terms.tsx` and the credits help doc now state the allowance/credit shape.
- **DONE 2026-08-28** (`atlarix-launchpad@72d04b6`). The Core guide embeds `CORE_EXPLAINER`
  from `products.ts` verbatim rather than restating it, which is the check that stops the
  next change leaving a fourth copy behind.
- **Reviewer's billing was undocumented everywhere and now is not.** It grants the SAME
  monthly allowance as Pro (`MONTHLY_GRANT_CENTS`) and debits the same meter; the Terms, the
  credits doc, the README and `REVIEWER.included` all say so. No dollar figures, per
  `billing_copy.ts`.
- **Read `ALL_DOCS` end to end against what the app does now.** `src/data/helpDocs.ts` +
  `guideDocs.ts` are the in-app error buttons' destinations, so a stale doc is reached by someone who
  is already stuck. The v14.35.0 Dyad-era removal alone deleted ~30,500 lines; anything describing
  retrieval, indexing or the old panel-based approvals is describing software that no longer exists.
- **The blog posts are dated artifacts and should NOT be rewritten** — `blogPostContent.ts` carries
  pricing tables that were true when published. Leave them; the fix for a stale post is a new post.
- **The README was advertising twice the product that exists.** "Four managed cloud models —
  Core 1 (fastest) through Core 4 (most capable). Every plan gets all four", in three places,
  when `core-models.json` configures TWO and an unconfigured slot reads as empty everywhere.
  Fixed 2026-08-28 by describing the lineup as remotely configured rather than restating a
  count that drifts; the same sentence was in `atlarix-releases/README.md` and moved too.
  **The general form: a doc that states a NUMBER the config decides will be wrong eventually.**
- **Coverage added 2026-08-28:** deep thinking and voice input, neither documented anywhere.
  **Passkeys deliberately NOT documented** — the device-stored authenticator is gone and the
  roaming flow has never been driven by hand, so anything written would describe unverified
  behaviour. An undocumented feature is a gap; a documented one that does not work is a
  support ticket.
- **The check that would stop it recurring:** every claim about pricing or plans now has ONE home
  (`src/shared/billing_copy.ts` and the launchpad's `src/data/products.ts`). Route the docs through
  those rather than restating them, and the next change propagates instead of drifting.

## 🧭 Designed — awaiting a session

### Core under concurrency — mostly SOLVED already; here is what actually remains

> Raised by the owner 2026-08-26 ("Core may need to cater for multiple instances at the exact same
> time, multiple users, and be secure"). Checked rather than assumed: `atlarix-proxy` already handles
> this deliberately, and its own header says so. Recording the residuals so nobody rebuilds what
> exists.

**What is already true, and should not be re-solved.** `balance-cache.ts` keys on `userId`
(`Map<string, Entry>`), so there is no cross-user read. It holds a **reservation** per in-flight call
at worst-case cost, which is precisely what stops an 8–12 call fan-out all clearing a gate only one
of them could afford. And correctness never depends on the cache: Postgres stays the sole authority,
every debit is JWT-scoped + RLS-backed and idempotent on the generation id. The file's own claim —
extra replicas make it *less effective, never incorrect* — holds up. `spend_from_wallet` takes
`FOR UPDATE` on the grant row, so simultaneous debits for one user serialise rather than race.

**Residual 1 — multi-replica overspend, bounded and cheap.** Each replica has its own cache and its
own reserves, so worst case is roughly one reserve of overspend per replica per user. At Core prices
that is cents, and the file already names the fix (swap the Map for Redis; the narrow
`tryReserve`/`release`/`settle`/`invalidate` interface exists for exactly that). **Not worth doing
until there is a second replica.**

**Residual 2 — the reviewer's cost attribution genuinely BREAKS on a second replica.** Unlike the
above, this one goes from exact to wrong. `ReviewQueue.spendSince` reconstructs a review's cost from
a `(source, repo, since-claimed)` ledger window, which is exact only because `startWorker` awaits
`runJob` and one replica is therefore strictly sequential. Two replicas reviewing the same repo would
each attribute the other's spend to itself. The fix is not a cleverer window — it is for the proxy to
return the debited amount on the response. **Do this BEFORE scaling the reviewer, not after.**

**Residual 3 — the service path bills whatever the header names.** A pull-request webhook fires with
nobody signed in, so `auth.uid()` is null and no owner-scoped RPC will work; the reviewer therefore
authenticates with a service token and passes `x-atlarix-account-id`. The proxy TRUSTS that header.
That is a deliberate, documented trade (the alternative was putting the reviewer inside the metering
boundary, which is worse), but it means **a leaked `REVIEWER_SERVICE_TOKEN` lets the holder bill any
account.** Worth noting the cross-check that is available and unused: the reviewer already resolves
the account from `github_installs` itself, so the proxy could verify the claimed account actually owns
an installation rather than taking the header's word. Cheap, and it turns a bearer secret into a
bearer secret plus a consistency check. Pairs with the existing "scope the reviewer's Postgres role"
item.

**What would change the picture:** any of these becoming real needs a *measurement* first — the
Supabase request count is the tell, and the 2026-08-26 lesson was that 704 requests/hour looked like
the website and was actually a 5-second poll. Do not scale on a hunch.

## 🔐 Security follow-ups — owner-triaged, deferred

The v14.8.12 review document was deleted once acted on (`b48002a6`). Fixed by v14.8.13: compound
danger gate, exfil taxonomy, deep-link auth-CSRF, MCP consent gate, `.atlarix` authority-file
approval, MCP description wrapping + OAuth-URL validation, the universal write-confining sandbox
(Windows since rebuilt on Low IL), and the system-scope approval gate (which also closed M1).
**Deferred:**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but release
  infra (signing certs + `app-update.yml` for NsisUpdater; out-of-band signature for AppImage), not
  app code. The owner chose not to gate the public release on it.
- **Native sandbox validation in CI.** The Windows/Linux helpers cannot compile on macOS.
  `npm run check:sandbox` cross-target type-checks both and the helpers are gated on behaviour, but
  neither substitutes for running them on the real OS.
- **Unattended read-only allowlist-flip** (a positive allowlist for automation runs) — the denylist
  taxonomy is done; the flip needs per-automation design to not break legitimate builds and tests.
- Sandbox **read**-confinement (Windows blocker above), **egress** gating, and the remaining Mediums:
  env-var key inheritance, secret-basename list, cross-workspace file scope, plaintext-keychain
  fallback.

## 💤 CLOSED — do not re-propose

- **Renaming the macOS bundle identifier. Owner's call, 2026-08-28: NEVER doing it.** It ships as
  `com.electron.atlarix` (@electron/packager's default) and it stays that way. The reason to stop
  proposing it: macOS ties `safeStorage`'s keychain ACL to the app's designated requirement, which
  includes the bundle id, so a rename can leave every existing user's stored provider keys and
  Supabase session **undecryptable** — the exact failure v14.27.0 existed to fix — and separately
  resets TCC folder grants and orphans the `atlarix://` registration. The upside was cosmetic.
  A cosmetic identifier is not worth a migration that can lock users out of their own keys.

- **Fork sub-agents. The arithmetic does not work.** A cache read is ~0.1× base input, but the
  inherited prefix is re-sent on **every step** of the worker's loop — an 8-step fork pays ~8× the
  discount it was meant to save, for context it never asked for. It only breaks even for a worker so
  short the parent should not have delegated. The cache hit also requires sharing the parent's
  toolset, handing the least-supervised worker the full write surface. The real problem — workers
  re-deriving what the parent knows — is answered by **pointers, not payloads**.
- **Model-context secret redaction. Decided twice** (v14.12.0, then again 2026-08-17 on the reframed
  version). The reframe was right that exact-string redaction of known values is zero-false-positive,
  and still not sufficient: **no list caters for every form a secret takes**, and the vendor-prefix
  tier is exactly the hardcoded-list pattern this project has repeatedly rejected — wrong at the
  edges, maintained forever, and implying a guarantee it cannot make. Display-side and telemetry-side
  redaction (Sentry `beforeSend`, git-stderr credential stripping) are a different concern and stay.
- **`browser-use`** — Python/Playwright (bad Electron fit), its own agent loop, and its one good idea
  (stable element refs) we already have via `browser_inspect` snapshot `ref`s. No capability gap.
- **`h5i` — reference only.** A peer harness, not a library, and its leverage is Linux, which we ship
  natively. Worth borrowing its `supervised` tier (egress allowlist), a capability we lack.
- **Dropped 2026-08-19:** the `.gitignore`-render profiler (six releases old, no observed problem);
  the `proxy-worker`-from-source self-test gap (a known limitation with a stated substitute,
  `proxy-passthrough.test.ts`, not a task); per-model sampling defaults (the `getTemperature` hook
  exists, but populating it needs a model we can show is hurt by `temperature: 0`); and the Windows
  path-validation matrix (scar tissue, no exploitable path, and it admitted it "may find nothing").
  Recover from git if evidence appears.

---

## 🪤 Traps worth not rediscovering

Grouped by where they bite. Each is the one sentence that would have saved the time; the long form is
in `git log -- docs/TODO.md` and `CHANGELOG.md`.

### Testing, and tests that pass for the wrong reason

- **A source-parsing test must be debugged before it is believed.** The preload-allowlist checker
  reported ~20 missing channels on its first run and every one was a false positive: an apostrophe in
  a `//` comment broke quote-pairing, and it was scanning main-process files that never touch the
  bridge. The instinct on a red mechanical check is to start "fixing" the product — verify the
  CHECKER first, on a case you know to be fine (here: the update buttons visibly worked).

- **A test that passes with the fix REVERTED is not a test.** Found on a path guard (since removed):
  its first tests all passed WITHOUT the guard, because on macOS a `\\host\share` path is not
  `isAbsolute` and fell through to a different branch that already rejected it. Measured, not assumed
  — the guard was commented out and the suite re-run. Where two branches can produce the same refusal,
  assert the WORDING, since that is the only thing identifying which one fired. **Any cross-platform
  guard written on a dev machine deserves this check**, and it cost nothing here: comment out, re-run,
  restore.
- **Prefer one unconditional rule over a per-platform one.** A `process.platform` branch needs a
  platform parameter to be testable at all, doubles the matrix, and leaves the same input behaving
  differently per platform — which an agent then learns wrong. If rejecting more costs nothing real,
  reject unconditionally and delete the branch.
- **Shared jotai default store leaks between tests.** `clearChatAtomsForChat` writes to
  `getDefaultStore()`, so an eviction recorded in one test was still set in the next and two
  assertions passed for the wrong reason. Reset every atom the code under test writes, not just the
  ones the test seeds.
- **`npx electron .` runs the STALE compiled bundle and skips Forge's native rebuild.** It is not a
  way to test a source change: it dies with `NODE_MODULE_VERSION` mismatch on a repo whose
  `better_sqlite3.node` predates the current Electron, and it silently ignores any new CLI flag. Use
  `npm start`, or the packaged app.

### Packaging, signing and native modules

- **`configureWebAuthn` before `whenReady` = SIGTRAP, exit 133** — `EXC_BREAKPOINT`, no exception, no
  log, nothing a `try/catch` sees. Electron's "call it early" means early *within* the ready phase.
- **`keychain-access-groups` on a nested binary = SIGKILL, exit 137** — while `codesign -v` calls it
  "valid on disk" and says it satisfies its Designated Requirement. Two plists: the group goes on the
  **top-level bundle only**, selected by `!filePath.includes(".app/")` (osx-sign's own test).
  `endsWith(".app")` is wrong — a helper bundle ends with `.app` too.
- **`process.exit()` does not reliably terminate Electron's main process** — use `app.exit(code)`.
  The packaged `--self-test` printed PASSED and then ran on for 22 minutes on Windows CI. Also: a
  diagnostic must carry a HARD process deadline, not just per-probe timeouts, or a failure to
  terminate is unbounded.
- **A restricted entitlement needs an embedded provisioning profile, or the kernel SIGKILLs the app
  on exec — while `codesign -v` still calls it valid.** `keychain-access-groups` is one. Signing
  succeeds, the signature IS valid, and AMFI refuses the exec anyway, because codesign validates the
  signature and AMFI validates the *authorisation*. Two different gates. Cost v14.35.0 two tags.
- **A local package is ad-hoc signed, so NO entitlement can be tested locally.** `postPackage`
  re-signs with `--force --deep --sign -` (because `packageAfterPrune` strips files after packager
  signs), so the bundle ends up `flags=0x2(adhoc)` with no entitlements and no hardened runtime.
  `self-test:packaged` is 9/9 here either way, which is precisely how the entitlement above reached
  a tag. Only a CI-signed build can falsify anything in this area.
- **`better-sqlite3` is the ONLY ABI-pinned native module.** `node-pty` is N-API (`Napi::` symbols in
  the prebuilt `pty.node`), and `keytar` is not a dependency at all. It needs **12.11.1** — 12.4.1
  does not compile against V8 15 (`External::New` gained a required tag, `This()` was removed).
- **Rebuilding in place breaks the test suite.** `@electron/rebuild` writes ABI 148 into
  `node_modules` and vitest runs under system Node; `npm rebuild better-sqlite3` restores it. CI never
  sees this because forge rebuilds the PACKAGED tree. (The `@electron/rebuild` CLI is also broken on
  Node 25 — irrelevant to CI, which calls the API, but it will waste ten minutes.)
- **Do not touch `postinstall`** — the trailing `|| true` guards **patch-package** (absent from the
  pruned tree), not the Electron install. Re-parenthesising it broke Windows packaging at tag time.
- **`node-abi` must know your Electron major** — 3.77.0 throws on 41/42/43; 3.94.0 is fine and still
  inside `@electron/rebuild`'s range, so no major bump is needed.
- **vite 8 compiles `import.meta.url` to `{}.url`** — undefined in a CJS build. `node-cron` was the
  only bundled package not guarding it, and the packaged gate caught a launch crash that tests, three
  type projects and lint all missed. It also FORKS a sibling located via `import.meta.url`, which
  cannot work inside an asar, so that path was already broken quietly.
- **A runtime dep that Rollup leaves as a bare `require()` MUST be declared in `package.json`** even
  though nothing imports it — that entry is what survives `packageAfterPrune`'s slimming
  (`keepRoots ∩ fullDeps`). `axios`, `bluebird` and `@mixmark-io/domino` are in `mainRollupExternals`
  for this reason; removing them ships a boot crash. **Check `mainRollupExternals` before believing
  knip.** `axios`'s direct range also drags `posthog-node`'s copy up to the SSRF-patched 1.19.0.
- **`electron-log` must stay BUNDLED** — externalising it initialises it twice and re-registers its
  `__ELECTRON_LOG__` IPC handler, crashing main at boot.
- **`--self-test` never reaches `whenReady`**, so it can no longer catch a `configureWebAuthn`
  regression. That needs a real launch.
- **E42 moved macOS notifications to `UNNotification`, which requires code signing to display** — an
  unsigned `npm start` silently shows none. Do not re-diagnose that as a regression. E43 dialogs also
  default `defaultPath` to Downloads; we set none anywhere, so that is the OS default changing.
- **`overrides` with exact pins fail the install loudly (`EOVERRIDE`), which is the lucky outcome** —
  a RANGE there would have silently held vitest at 3 and the upgrade would have "succeeded" while
  changing nothing. `vitest` + `@vitest/ui` stay EXACT: their peer link is an exact version.

### Release and CI

- **A harness that swallows the failing output turns a one-run diagnosis into a
  multi-run guess.** `run-packaged-self-test.mjs` discarded the packaged app's own
  output on failure, so the macOS arm64 launch failure took several tag attempts to
  read. Whatever a CI wrapper does with a failure, it must PRINT what the wrapped
  thing said. (v14.35.0)
- **Windows MSIX: `@electron/node-gyp` can fail to find Visual Studio with nothing in
  the toolchain having moved.** Diagnosed and fixed at v14.35.0; the `VCINSTALLDIR`
  route was considered and deliberately rejected. Full narrative in the git history
  for that release — the lesson is that a green macOS/Linux matrix says nothing about
  the Windows job, which is also the only one that runs the test suite on Windows.


- **Verify the artefact users reach, not the one you just wrote.** `/releases/latest` is picked by
  `created_at`, and `atlarix-releases` has ONE commit — every release ties, and the tie never breaks
  forward. Needs `make_latest` plus a read-back of `/releases/latest` itself.
- **`curl -sS` exits 0 on an HTTP error.** A 503 mid-publish shipped a release as a DRAFT with all 12
  assets attached and every job green. Retry, then read the release back.
- **A 4–10 second failure with no retrievable log is a BILLING problem**, and the cause is only in
  the run **annotations**: *"The job was not started because an Actions budget is preventing further
  use."* Workaround is flipping the repo private → public for the release window (Actions is free on
  public) — ask first, and remember clones made during the window persist.
- **A hung job writes NO log** — `build-linux` sat 79 minutes on `apt-get` (11s the release before).
  Watch the **step's** `started_at`, not the run's. `cancel` + `rerun --failed` is lossless:
  successful jobs keep their outputs and uploaded assets are untouched.
- **Duplicate asset uploads 422 *green* while keeping the OLD asset** — delete the draft before
  re-tagging.
- **Verify `extract-changelog.sh` matches your heading BEFORE tagging.** The workflow passes
  `${TAG#v}`, so the `v` is stripped; the body must exceed 700 bytes or it is the bare download list.
- **Actions storage is a separate billing trap** and looks like nothing — no dead workflow, just an
  email. Cause was nine `atlarix-msix-x64` artifacts at 163–326 MB and 14-day retention (2.2 GB), for
  an artifact nothing downloads because Store submission is automated. Upload is now conditional on
  `workflow_dispatch` or a failed submit, retention 2 days. Diagnostic:
  `gh api "repos/AmariahAK/Atlarix/actions/artifacts?per_page=100" --jq '.artifacts[] | select(.expired==false) | "\((.size_in_bytes/1048576)|floor) MB  \(.name)"' | sort -rn`
- **`latest-mac.yml` is arm64-only by design.** CI sets `ATLARIX_CORE_MODEL_*` as real secrets.
- **A step that reads as success while the thing did not happen** is the recurring class here — three
  instances in one day. Read the result back, always.

### Migrations and Postgres

- **The source of truth for a `CREATE OR REPLACE` body is the newest MIGRATION that defines it** —
  never an audit snapshot, a docstring, or an older migration. `supabase/audit/prod_schema.sql` is
  **stale**: it predates the pricing-reframe teardown, which dropped `team_members`, `teams`,
  `users.team_id` and `users.has_db_studio_legacy`.
- **plpgsql resolves record fields at RUNTIME, not at definition time.** A body referencing a dropped
  column applies cleanly, the migration reports success, and then the first client `UPDATE` raises
  `record "new" has no field …`. The ban migration nearly shipped exactly that, which would have
  broken every authenticated write to `public.users`.
- **A verification fixture more generous than production verifies nothing.**
  `verify-ban-guard.mjs` invented `team_id`, `has_db_studio_legacy` and a `team_members` table, so it
  passed a body that could not run. Its column list now mirrors the live table.
- **Postgres `CREATE FUNCTION` grants EXECUTE to PUBLIC** — REVOKE for service-only DEFINER RPCs.
- **`created_at` defaults to `unixepoch()` — whole SECONDS.** Ties are undefined, so message order
  needs a **`rowid`** tiebreak; `id` is a random UUID, deterministic but WRONG. Worse, the DELETE
  paths sliced on that order, so a tie could delete the wrong message.
- Hand-write SQL + the journal entry + `db:bundle-sql` — the generator is not the source of truth.

### Models, dispatch and capability

- **`compass` is a WIRE id, not a vendor, and conflating them makes reasoning silently
  inert.** Rule, stated in the code: **dispatch keys off the wire provider; capability
  keys off the vendor** (`resolveDispatchCapabilityProviderId`).
  `detectReasoningCapability` deliberately keeps the WIRE provider — it classifies which
  request SHAPE a route accepts, not who serves the model, which is what routes an
  OpenRouter-backed Core tier to the `reasoning` object while a direct-routed one gets
  `reasoning_effort`. A tier's catalog id encodes the difference by itself (slashed =
  OpenRouter, bare = direct), so no branch is needed. (v14.37.0)
- **A camelCase `reasoningEffort` key sends NOTHING and throws nothing.** Provider option
  keys are wire contracts; a plausible-looking one is accepted and dropped. Assert on the
  DISPATCHED request body, never on the settings object. (v14.37.0)
- **Anything reporting on a turn must read what DISPATCHED, not what was SELECTED.** When
  the selected provider has no usable key, `getModelClient` falls back to Atlarix Core and
  rewrites the model INTERNALLY, leaving `effectiveModel` naming the original choice. Stats
  read off the selection filed Core's work under the user's own key — the exact distinction
  the feature existed to draw. Take it from the model client. (v14.36.0)

### The harness

- **A decision that is GLOBAL cannot be made from per-window state** — and its mirror, a per-window
  decision made from global settings, put a Build turn in a read-only sandbox (`cannot lock ref
  'HEAD'`) across five sites, triggered by an EFFECT on window open with no click. Concatenate
  `main.old.log` + `main.log` when reading either. A runaway also ACCELERATES as history grows, so a
  feedback loop is easier to spot by its changing period than its rate.
- **The preload strips the Electron event** — renderer listeners must be `(payload) =>`; 11 written
  `(_e, payload)` silently never fired. `on` is now one-param, so it is a compile error.
- **A broadcast that early-returns on the empty case can never clear a loading flag** — the failure
  case is exactly the case that gets no message.
- **One slot per chat is wrong wherever the subscriber is per-MESSAGE.** Three permission registries
  were `Map<number, handler>` while the approval card renders per assistant message, so
  last-registration-won and an unmounting message could leave the chat with **no handler at all**.
  Four dispatch sites, not one — the in-band chat-stream path is easy to miss.
- **The tool DEFINITIONS live inside the first prompt-cache breakpoint**, so growing them mid-session
  invalidates the entire cached prefix. That is why tool reveal tiers **descriptions per MODE** rather
  than laddering. And **a pointer cannot replace a correction**: descriptions that steer away from a
  known failure belong in `NEVER_TRIM`, because a model about to make the mistake does not know to
  call `tool_help` first.
- **`simplifyToolParametersForProfile` keeps only the first THREE optional params** — a fourth is
  invisible to exactly the weak models that need it. A schema-level `required` array is tool-WIDE, so
  per-operation requirements must be enforced inside the handler.
- **`ai@7`'s `response.messages` is final-step-only.** Any turn whose tool call ran in an earlier step
  loses its entire native tool exchange, and the next turn carries no `role:"tool"` history. Same
  types, same shape; only the native-history evals caught it. Use accumulated `responseMessages`.
- **One version-agnostic model-type alias, never a union.** Seven files spelled
  `LanguageModelV2 | LanguageModelV3` and needed a hand-edit every SDK major; `AtlarixLanguageModel`
  makes the next spec bump free.
- **A raw NUL byte makes ripgrep silently skip a file** in a recursive search — the `binary file
  matches` notice only prints for files named explicitly. Four of our own source files were
  unsearchable, and `git diff` showed three as `Bin`, so review could not see them either. Write
  `\u0000`.
- **Every NEW tool needs `LABELS`/`DONE_LABELS` entries and a `buildToolExpandView` branch**, or the
  card reads "Runned <tool>" and slices the body at 300 chars mid-token.
- **Guards guide via the result channel, never dead-end.** A tool that returns `success:false` into
  silence is the first domino — the completion gate then holds the turn open on the unticked step and
  offers "rewrite the whole plan" as the way out, which loses the record of what was done.
- **Truncation must not reorder.** `formatCommandOutput` emitted a fixed ~13 lines regardless of an
  80,000-byte budget, out of order, with no count of what it dropped — so sampled and complete output
  looked identical and a model re-ran the command to recover information that already fit. Two-pass
  fill is required, because the notice and the excerpt reservations depend on each other.
- **The AI SDK stack must stay on MATCHING majors** — `ai@7` + v4-spec providers, and zod moves with
  them. Never mix spec lines.
- **A sub-agent borrowing the parent's interceptor inherits the parent's `turnWorkMode`** — a QA
  worker spawned from a Build turn would get workspace-write. `preview.readOnly` is NARROWING-only,
  and `enforce` is deliberately NOT set for the mode-driven case, or every Explore/Plan/Review command
  would newly fail on a machine with no OS sandbox.
- **`resolveBrowserScope` falls back to the focused window**, so a caller that forgets
  `_ownerWindowId` silently drives whichever window the user is looking at — and retargets mid-task if
  they switch. Worse than an error, because nothing reports it.

### Auth, bans and the client

- **`useAuth.loading` cannot distinguish "signed out" from "not known yet"** — use `authResolved`.
- **Naming a column that does not exist yet in the plan SELECT makes EVERY user read as free.** The
  PostgREST error falls through to `offlinePlanOr('free')`. Deploy the migration first, or query the
  new column independently and fail open.
- **A ban blocks the whole client, not just Core.** The gate sits in front of the launcher, so BYOK
  and local models do not work while banned. Only the in-turn 403 message makes the narrower claim,
  and it is correct there. The proxy's 403 is the only enforcement that survives an old build or no
  network. `isUserBanned` fails OPEN on a failed read, deliberately.
- **Agent memory had a self-perpetuating deadlock**: the absolute store path was published only when
  notes existed, so on an empty store the agent invented a human-readable path, wrote outside the
  store, and kept the store empty. Publish the RESOLVED path unconditionally, and when adopting a
  stranded directory **read the destination back and verify the count BEFORE deleting** the source.

### Prompting and the model

- **Never publish a fillable path in a prompt.** `~/.atlarix/projects/<slug>/memory/` is an
  invitation to complete it: the agent ran `find`, took a stale copy, and broke mid-session with the
  right path in context all along. Publish the RESOLVED path and say it is the only one.
- **An error names the model that REPORTED it, not one that was ever loaded** — run the
  device × dtype matrix before diagnosing.
- **Measure the thing; do not infer it from a manifest.** vite 7+ was capped by reasoning about
  export conditions, and `require("vite")` resolves fine at 8.2.1 under both Node builds.
- **Scope by what the repo contains, not by where you last looked.** The dyad-removal manifest
  enumerated `src/` and stopped, so `e2e-tests/`, `packages/` and `src/pro/` were invisible — three of
  the four biggest finds, and the estimate was off by 15×.
- **Check REACHABILITY, not presence.** Four clusters compiled, type-checked and were imported, and
  nothing could reach any of them.
- **A test that pins the OLD behaviour must be rewritten, not deleted** — and verify a new test would
  have caught the bug, since these sit green either way until checked.
- **Verify a compiler or linter diagnostic with an isolated probe before believing its scope.** TS 7
  flagged `(x ?? y ?? undefined) ?? undefined`, which as worded would have implied a jotai/TS7 fault
  across hundreds of call sites rather than one redundant operator.
- **papaparse's delimiter auto-detection is wrong when `skipEmptyLines` is false** — a trailing
  newline skews the heuristic and a `;`/tab file parses as ONE column, silently, with
  `success: true`. And `Papa.unparse` quotes whitespace cells, so a text-based emptiness check stops
  firing; check the matrix. Set `newline: "\n"` (unparse defaults to CRLF).

### Windows-only

- **A drive-letter colon is not a field separator** (grep discarded every match), and an absolute
  glob must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine
  catches either.
- **AppContainer is deny-by-default on READS** — the inverted primitive, unfixable per-path, which is
  why the sandbox was rebuilt on Low Integrity Level. HKCU is virtualized, so `atlarix://` MUST be in
  the manifest. Linux `ABI::V2` let `truncate` bypass confinement.
- **`cargo check --target x86_64-pc-windows-msvc` works from macOS**; `cargo build` on these
  `cfg`-gated crates proves nothing.
- **`.includes("/Documents/Atlarix")` can never match a backslash path** — a managed workspace on
  Windows got the reassuring copy and then had its files deleted. Match on path segments with either
  separator, case-insensitively.
- Node 25 still breaks better-sqlite3's `llvm-lib /LTCG:INCREMENTAL` on windows-latest.

---

## ✔️ Checked and CORRECT as-is — do not "fix" these

From the 2026-08-05 hardcoding sweep and the v14.26.0 permission-surface audit. The test in every case
is *what happens when the list is incomplete*; the reasoning is in git and `DESIGN_NOTES.md`.

- **`defaultWritablePaths`** (`lib/sandbox/wrap-command.ts`) — a *write* allowlist; incomplete fails
  CLOSED into the escalation flow. Probing `$HOME` dynamically would WIDEN the sandbox.
- **`DANGEROUS_PATTERNS`** / **`SYSTEM_SCOPE_PATTERNS`** — UX gates, not boundaries; the sandbox
  catches anything unlisted.
- **`DENIAL_PATTERNS`** — extracts a path from tool prose; a miss degrades into
  `sandbox-failure-context.ts`, not into silence.
- **Browser error capture** (`lib/browser/error-hook.ts`) — filters on the browser's own console
  `level` and HTTP status, never on curated strings. Already derived.
- **`file-permission-scope.ts`** — the v14.23.0 protected-path deletion has not crept back.
- **`models_dev.ts` / provider dispatch** — de-hardcoded in v14.23.0; only documented pins remain.
- **Browser `KEY_ALIASES` / `MODIFIER_TOKENS`** — a closed set from the DOM spec.
- **The permission surface is layered, not duplicated** — four duplication hypotheses, all four
  refuted by the code. `guard.ts` is not a permission mechanism at all. Do not re-open without new
  evidence; see `DESIGN_NOTES.md`.
- **`write:true` cannot turn a `qa` spawn into a writer** — `subagentWillWrite` returns
  `agentIsWriter(agent)` for a NAMED agent and ignores the flag. Non-obvious, load-bearing, pinned.
- **QA is NOT advertised in Plan mode**, deliberately: you plan before building, so there is nothing
  running to test.

---

## 🔭 Long-term — not soon

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat and calls are a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack, Discord, GitHub issues — the same shape the PR
  reviewer takes on GitHub ([`atlarix-pr-bot-spec.md`](./atlarix-pr-bot-spec.md)): mention it, it
  picks up the task, works in a real Atlarix workspace, posts the result back (near-zero switching
  cost; how Devin and Copilot-in-Slack win). (b) A **shared, observable agent session** — a war room
  where teammates watch one run live, drop steering comments, approve actions and hand off, tied to
  the Workforce tier. The chat shell is not the differentiator;
  the shared *agent* session is. Capture, don't build yet.

---

## 📦 Shipped — index

Full prose in [`CHANGELOG.md`](./CHANGELOG.md) (current window) and
[`CHANGELOG_PREVIOUS.md`](./CHANGELOG_PREVIOUS.md) (archive). This table is the version → trap map;
the traps themselves are consolidated above.

| Version | Shipped | Trap |
| --- | --- | --- |
| **v14.38.1** | Usage bar as a percentage; purchased-credit headline; per-product allowance % and spend on the account page; two startup bugs | A module-level rule is not enforcement — `billing_copy.ts` forbids printing the allowance in dollars and the first thing that rendered it broke that rule. `vi.mock("electron")` does NOT reach a `createRequire` consumer, and `log.scope(name)` returns a NEW logger per call — both produce a green test that asserts nothing. **Confirm a regression test FAILS against the old code before keeping it.** `--doctor` never called `initializeDatabase()`; a bare `catch {}` reported that as the user's database being broken, next to a `Local database: OK` row. |
| **v14.38.0** | Core included with Pro; the refund path the subscription wallet shipped without; browser tools on localhost; what's-new panel | A refund must reduce a period total by the amount **taken**, not the amount requested, or consumed exceeds total. Backfill a new column from the LEDGER, not from the remaining balance. A `WebContentsView` never added to the hierarchy lays out at ZERO WIDTH, so every answer about the page is plausibly wrong. Resolve a refund's account from the subscription row ONLY — taking from the wrong account is worse than granting to one. |
| **v14.37.0** | Deep thinking on Core and every OpenAI-compatible provider; lines-written stats; web-search query fidelity | `compass` is a WIRE id, not a vendor: dispatch keys off the wire provider, capability off the vendor. A camelCase `reasoningEffort` sends NOTHING and throws nothing — assert on the DISPATCHED request. Anything reporting on a turn must read what dispatched, not what was selected, or a Core fallback files its work under the user's own key. |
| **v14.36.0** | Diagnostics panel + `--doctor`; the database dead-end; per-session work mode; cold-chat eviction; debug routed like build; memory location at the top of the prompt | A new IPC channel is TWO edits — handler AND preload allowlist; three were missing and one (`sessions:snapshot-turn-ids`) was a live pre-existing bug behind a silent `catch {}`. A test that supplies the argument itself proves nothing about whether production passes it: four of five work modes lacked the memory path. Request counts did not distinguish the ask and build runners — diffing IPC channels did. `operation-targets` ended `default: break`, so an unknown operation was gated against nothing. |
| **v14.35.0** | Electron 43, Touch ID passkeys, browser-backed web search, the spec-line majors, 54 → 28 advisories, the Dyad-era removal, the ban system, four plan-tracking fixes | Two silent macOS packaging traps (SIGTRAP 133, SIGKILL 137). `response.messages` became final-step-only. A stale `CREATE OR REPLACE` body nearly broke every client write to `users`. A NUL byte makes ripgrep skip a file. `created_at` is whole seconds. The plan ledger went stale at the **round** boundary, not the step boundary — `run-agent-turn` restarts `stepNumber` at 0 per round, so a take-once queue was already drained. Measured web search: 24/29/25 results where DDG and five public SearxNG instances returned 0/0/0. |
| **v14.34.0** | Atlarix tests its own work; two windows stop fighting over one mode | A per-window decision made from GLOBAL settings put a Build turn in a read-only sandbox, across five sites, triggered by an effect on window open. Truncation was discarding 99% of its own budget and reordering. Sub-agents had **no way to ask**, which read as safety and was why they could not run commands. |
| **v14.33.0** | automations that tell the agent; `operation:"run"` | Published ≠ latest, and `curl -sS` exits 0 on an HTTP error. **Verify the artefact users reach.** |
| **v14.32.0** | native PDF parts; process-tree kill; `read_url` cache; browser panels per page load | A GLOBAL decision cannot be made from per-window state — 84 turn restarts in six minutes. Capability gating is **per MODEL**, never per provider (OpenAI accepts PDF on 15 of 47). `proc.killed` only records that you signalled. |
| **v14.31.0** | Network tab; browser runtime gating removed; session-restore hang | `Network.enable` **hangs forever** on a never-navigated tab. A `Notification` unreferenced after `show()` is GC'd mid-display → native SIGSEGV. A broadcast that skips the empty case cannot clear a loading flag. |
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it. `postinstall`'s trailing `\|\| true` guards patch-package, not the Electron install. |
| **v14.29.0** | automated Store submission; WSL Landlock confinement | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads 422 green while keeping the OLD asset. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads**. `cargo check --target …-msvc` works from macOS; `cargo build` proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows drive-letter colon is not a field separator. `path.isAbsolute("C:\\x")` is false on macOS. |
| **v14.25.0** | honest context accounting; skills on demand; one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
