# Atlarix design notes

The **why** behind decisions that still stand, and work that has been designed but not
scheduled. Each entry exists so the conversation resumes cold instead of being re-derived.
[`docs/TODO.md`](./TODO.md) carries a one-line pointer per open entry; this file carries the
reasoning. What shipped is in [`docs/CHANGELOG.md`](./CHANGELOG.md); how Core is billed is in
[`docs/CORE_BILLING.md`](./CORE_BILLING.md).

Nothing unscheduled here is a commitment. An entry graduates to TODO when it becomes active work.

**Last updated:** 2026-09-28

---

## The Auto/Zenith selector in shadow — measured 2026-11-05, NOT built

**What exists.** The proxy's ladder (paid-auto.ts `sessionProvider`/`advanceLadder`, ladder-session.ts): one
provider per session (25% Anthropic), climb a level after 2 quality failures (retry header, repeated identical
tool calls, a failed edit) or at once on escalate, switch provider once at the top, `topFailed` → the app offers
Zenith. Every paid step is logged in `auto_steps` (metadata only).

**What the data says (all of `auto_steps`, 2026-10-30 → 11-05; SELECT only):** ~1,200 steps from ~10 real
sessions, most of them the team's own on 10-30/31. **Zero climbs and zero top failures**: nothing for a learner
to learn from yet. Two things it does show:
- Paid-Auto build steps on OpenAI averaged **112¢/step** (266 steps, 4 sessions) against 18¢ on Anthropic
  (86 steps): the 10-31 spend incident's 350-485k-token contexts, since fixed (working window, cache tail,
  compaction). Re-measure after 15.13's cache work before reading anything into provider cost.
- 477 explore steps logged `start_level=luna, level=terra` with no climb recorded. Either the explore lane
  is pinned to Terra somewhere the ladder doesn't log, or `elevated_*` isn't written on that path. Check before
  any selector uses `level` as a label.

**Decision.** Keep the ladder; no learned selector yet. Revisit when `auto_steps` holds ≥ 200 real (non-team)
paid sessions with at least a few dozen climbs. Then, per the owner's 10-29 notes: (1) the on-device contextual
bandit and (2) a cheap hosted classifier, both in `shadow` (log their pick beside the ladder's), compared on
cost and outcomes; per-session provider kept (per-exchange switching breaks the cache); cold start from the
user's own task profile, then a weak shared prior from anonymised outcome buckets with per-account caps.

## Relics, CLI distribution, search — 2026-10-02

**Relics: where they live, and why they can't hurt anyone.** Hosted only on paid Core
(`src/lib/relics/hosting-tier.ts`; the `relics` edge function re-checks); own keys and free Auto
write `.atlarix/relics/<slug>/` instead. Bytes go to Cloudflare R2, never Supabase (its org is over
quota); Supabase keeps only `relics` / `relic_versions`, service-role only. The edge function decides
who may view (owner, or anyone once shared by link) and mints a 15-minute HMAC token
(`supabase/functions/_shared/relic-token.ts`, copied byte for byte into the Worker). The
`relics.atlarix.dev` Worker only checks tokens and serves files with a strict CSP (`connect-src
'none'`, framed only by atlarix.dev). The viewer frames it with `sandbox="allow-scripts"` and no
`allow-same-origin`: an opaque origin on another site, with no cookies, so a relic's scripts can draw
and nothing else. Live updates poll the Worker's `/s/<token>` (a tiny JSON from R2), not Supabase. In
the desktop app a hosted relic's card opens the link (the app's renderer is `file://`, which the
Worker's `frame-ancestors` can't name); a local relic previews inline via `srcdoc` in the same
sandbox, read through `relics:read-local`, which only reads an `index.html` under a workspace's
`.atlarix/relics/`.

**The CLI ships as one binary per platform** (`scripts/cli-targets.mjs`): Bun-compiled, with
ripgrep, the bridge relay and opentui's native renderer for that target embedded (fetched per target
by `scripts/ci/fetch-platform-packages.sh`, never `npm install`). Each release leg builds on a native
runner and runs `scripts/cli-smoke.ts`. npm keeps the single `atlarix` package the cloud agent runs:
it is now a small launcher that executes the matching `atlarix-<platform>` optional dependency, and
falls back to the bundled Node build where there is none, so `atlarix run` works everywhere and the
two workflows can publish in any order.

**Web search has no paid or hardcoded API** (owner, 2026-10-02). The app keeps its hidden browser;
the CLI searches through the user's Chrome (bridge op `search`, in the CLI's own tab group);
otherwise a search MCP. Each Atlarix process has its own tab group: the bridge stamps
`client: "app" | "cli"` on every request and the extension keys groups by it, keeping the app's old
storage keys so nothing migrates.

## Automations and the browser run in whichever Atlarix is open — 2026-10-02

The desktop app and the `atlarix` CLI share one database, and both now run automations and want the
user's browser. Each needs exactly one owner per occurrence.

**Automations: a lease per occurrence** (drizzle 0077, `src/lib/automations/runner.ts`). Both
processes arm their own timers. Before running, a process inserts `(automation_id, slot_key)` into
`automation_leases`; the primary key lets one insert through and the loser skips. A schedule's slot
is its fire minute, an MCP poll's is its interval bucket, run-now takes none (it happens where it was
asked). Runs carry `owner` + `heartbeat_at` (beaten every 30 s); startup recovery fails only runs with
no owner or a heartbeat older than 2 minutes, never the other process's live run. Each runner re-arms
what the OTHER process created or changed every 60 s, comparing `enabled|trigger` — not `updated_at`,
which a poll's cursor write bumps (re-arming on it would re-poll forever).

Like Claude Code `/loop` and desktop scheduled tasks, and Codex automations: they run only while an
Atlarix is open, and a missed occurrence is not caught up. "While the machine is off" is the cloud
agent's job, not a background service's.

Known gap: a desktop app from BEFORE 0077 ignores leases, so with a new CLI the same schedule can fire
in both until the app updates. Both ship from one tag; not worth a `min_reader` bump.

**The browser: host and peers** (`src/lib/bridge/server.ts`, `peer.ts`, `src/main/bridge-lifecycle.ts`).
Only one process can own the socket the relay dials. The first to start hosts it and also serves
`<socket>-peers`; a later one finds the main socket live and joins as a peer. A peer's requests go
through the host's own `request()` (same correlation and timeouts) and the reply goes back to the
peer. When the host quits, peers see the socket close and one takes the main socket over (jittered
retry; the loser finds it live and becomes a peer); the extension's reconnect then finds the new host.
The extension is unchanged — it never knows there are two Atlarix processes, so both share its one
tab group for now. The CLI embeds the relay but installs the native host only where none is
installed (`installHost: "if-missing"`): the desktop's install already points the browser at the same
socket and its relay is the one to keep.

## Device-code sign-in for the CLI — 2026-10-01

`atlarix login --device` (default over SSH or with no display) is RFC 8628's flow with one
addition: the CLI makes an ECDH P-256 key pair per sign-in and sends the public half with
`start`; `approve` seals the session to it (HKDF → AES-GCM, `_shared/device-seal.ts`, one file
run by both Deno and Bun). The table stores the device code only as SHA-256 and the session only
sealed, so a database read gives neither a pollable code nor a session.

The weakness of every device flow is phishing ("enter this code for me"). Answers: no
`verification_uri_complete` — the code is always typed, never carried by a link; the approve
page shows when the sign-in started and what it says it is, and says to decline a code someone
sent you. The label is the CLI's own claim and is shown as such. A guessed code (20^8, 10
minutes) would sign the victim's terminal into the GUESSER's account, which the CLI prints by
email at once. `start` is capped per address (HMAC of the IP, never the IP); polling faster than
the interval earns `slow_down`; a collected session deletes its row in the same statement.

The approving session is fresh — signed in on the page with the memory-only client, as
/auth/app — so signing the CLI out later ends only the CLI.

## The CLI shares the desktop's data, not its sign-in — 2026-10-01

The interactive `atlarix` CLI opens the desktop app's own folder
(`~/Library/Application Support/Atlarix` and the Windows and Linux equivalents,
`src/cli/desktop-data.ts`). So the chats, sessions and settings are one set, and
`/resume` picks up a desktop chat. That choice has consequences the code now enforces.

**Two programs, one database, updated separately.** An older build will meet a
database a newer one has migrated.
- *Additive migrations* are fine. Older builds ignore what they don't know.
- *A migration that would break older readers* raises `__atlarix_schema_meta.min_reader`
  in the same migration. Bump `READER_VERSION` in `migrate_atlarix.ts` to match.
- *Refusing to open.* An older build refuses a database whose `min_reader` is above its
  own and says "install the newer version". It never wipes: before this, the
  equality check on the migration count sent an older build down the retry path, which
  deleted `sqlite.db`.
- *Live readers.* A reader-breaking migration also refuses to run while another program
  has the file open (`__atlarix_clients`, a 30s heartbeat; rows older than 90s are
  ignored). An older reader that is already open would otherwise keep reading a schema
  that changed under it.
- *Backups.* Every migration run is preceded by a copy in `backups/before-update/`
  (newest three kept).
- *The CLI never deletes.* It sets `ATLARIX_DB_SHARED=1`, and `atlarix run` refuses to
  start with it set, because batch runs rewrite settings and add a workspace per run.
- *Concurrency.* WAL mode, plus a 10s busy timeout.

**Keys are shared; the sign-in session is not.**
- *Keys.* Provider keys are encrypted with Electron safeStorage, which is Chromium's
  OSCrypt. `src/runtime/oscrypt.ts` reimplements it with the same OS key: the macOS
  keychain item "Atlarix Safe Storage", DPAPI via `Local State` on Windows, and the
  Secret Service on Linux, best-effort. A key saved in either program opens in the
  other. On macOS the first read from the CLI asks the user once.
- *Sign-in.* The session is deliberately separate: the CLI signs in on its own.
  Supabase refresh tokens ROTATE, and two processes refreshing one token race. The
  loser's token is already spent, and that looks to the person like a random sign-out.
  Separate sessions never collide.
- *Sign-out.* Each surface's sign-out now ends only its own session. The desktop used
  supabase-js's default "global" sign-out, which also signed the person out of the
  extension. It now uses `scope: "local"`, as the extension already effectively did.
- *Attribution.* The CLI sends `X-Atlarix-Surface: cli` (`ATLARIX_SURFACE` follows the
  environment the CLI sets before anything is imported). The proxy already accepts
  `cli`, so ledger rows are attributed correctly.

**Web search in the CLI: an automated browser is not a search engine.** Measured
2026-10-01 against Brave Search from this Mac's home connection:
- *Headless browser:* a captcha from the third query.
- *Normal browser window off-screen:* results at first, then Brave's "Verifying you're
  not a bot" check (which keeps the plain "Brave Search" title) for every query, after
  about 50 automated queries in half an hour.

So the CLI's search order is:
1. the user's own Chrome through the extension bridge, where a person can answer a
   check themselves;
2. an off-screen system browser, only where a display exists, best-effort;
3. otherwise a plain message saying what to connect.

Nothing in Atlarix answers a bot check. A paid search API behind the proxy is the
reliable answer for machines with no browser; it is an owner decision (budget, deploy).
The desktop's hidden-window tier will meet the same check under heavy use.

## The cloud agent and email sign-in — BUILT 2026-09-28

_Why the cloud agent runs in the user's GitHub Actions, and why every credential at that boundary
is shaped the way it is. Read this before widening any of them._

**The product.** Someone asks from Slack or atlarix.dev ("owner/repo: fix X"), Atlarix works on
the repository while their machine is off, and a pull request comes back with Approve & merge.
Approving merges; their existing pipeline deploys. We never hold deploy credentials.

**Why the user's runner, not ours.** GitHub's coding agent and claude-code-action both run in the
customer's Actions. It costs us no compute (public repos are free for them; private repos use
their minutes), and their code never lands on a machine we operate. A managed sandbox (Cloudflare
Sandbox, E2B, Daytona) is the upgrade for GitLab/Bitbucket and faster starts, once revenue
justifies it. Priced 2026-09: E2B/Daytona ~$0.05/vCPU-hr, Cloudflare $0.072/vCPU-hr of ACTIVE CPU.

**Four credentials, each as small as it can be.**

- **Runner → us: GitHub OIDC.** No secret in the user's repo. The claim requires `repository` =
  the job's repo, `workflow_ref` = `.github/workflows/atlarix.yml@refs/heads/*`, and
  `event_name` = `repository_dispatch`. Without the workflow check, any workflow in the repo,
  including one a contributor adds in a PR, could claim a job and get its run token.
- **Runner → Core: a run token.** HS256, shared between atlarix-reviewer (mints) and atlarix-proxy
  (verifies), naming one user and one job, 60 minutes. The proxy re-checks that the job is
  `running` (15s cache), and `debit_wallet_cloud` refuses a non-running job, so finishing a job
  kills its token before `exp`. It is not a Supabase session, which would be the whole account.
  The CLI reads it from a file and deletes it; it is never in the agent's environment.
- **Runner → GitHub: a push token**, fetched only AFTER the agent exits, scoped to one repo
  (`contents` + `pull_requests`), with no fallback to an installation-wide token. Pushing with it
  (not `GITHUB_TOKEN`) is what makes the user's CI run on the PR.
- **The Agent App is separate from the Reviewer's.** The Reviewer is read-only and "never
  merges", and adding write permissions to it would re-prompt every install. `github_installs.app`
  tells them apart, and the proxy's reviewer service path counts only `app = 'reviewer'`.

**Who may do what.** Slack identity is never proof of an Atlarix account. A link is made on
atlarix.dev by the signed-in holder, from a 30-minute signed token the bot sent. Approve
re-resolves the CLICKER's link, so a teammate in the same channel can neither start work on
someone else's wallet nor merge someone else's PR. Model-written summaries are escaped before
they reach Slack, so a summary cannot contain `<!channel>`.

**Which model a run uses (owner decisions 2026-10-03, 2026-10-23).** The cloud agent is a paid
feature: paid Atlarix Auto by default, or any paid Core tier, billed to the balance (PAYG or Pro).
The job carries the choice (`cloud_jobs.tier`), set when the run is started (the model picker on
atlarix.dev; Slack is always Auto) and validated against the live Core lineup. The workflow file
cannot change it. Own-key cloud runs were removed on 2026-10-23: one Slack lookup of a repository's
own-key setup that couldn't be read billed Auto in its place, the App's secret-writing permission
was its riskiest, and none of the comparable agents take an own key in the cloud. Own keys and
local models stay in the desktop app, the CLI and the editors.

**Never free Auto.** Free Auto shares prompts with OpenAI, and a private repository's code is not the
installer's to share. Long unattended runs are also exactly what free tokens get farmed for. The
proxy's `freeOffered` excludes the `cloud` caller by construction, and a cloud run asking for Auto
while paid Auto is off gets 503 `cloud_requires_paid_auto`, never the free chain. Any other model
takes the normal paid Core path, billed through `debit_wallet_cloud`.

**The Core token never reaches the agent.** `run.mjs` writes the job's run token to a 0600 file,
the CLI reads it with `--core-token-file` and deletes it, and the agent's child environment drops
every `INPUT_*` and the runner's OIDC request credentials (`lib.mjs` `childEnv`).

**Email sign-in lives on atlarix.dev.** Turnstile only renders on a hostname registered to its
site key, so neither the Electron renderer nor an extension page can show it. The app and the
extension open `/auth/app?client=…&state=…`. The site signs in with a client that stores nothing,
so two holders never share a rotating refresh token, and redirects to a FIXED target per client
with the tokens and `state` in the hash. The desktop checks `state` (OAuth stays stateless, see
the TODO); the extension checks it and immediately refreshes, which spends the refresh token that
travelled in a URL.

---

## The e2e suite — RETIRED 2026-08-19, and why not repaired

_Recorded so "we should bring back e2e" starts from the measurement rather than the instinct._

**The measurement:** of the 68 `getByTestId` values the suite referenced, **60 no longer existed in
`src`** — 88%. Not peripheral ones: `chat-input-container`, `messages-list`, `chat-mode-selector`,
`approve-proposal-button`, `copy-message-button`. It encoded the Dyad-era app model (apps with preview
iframes) rather than workspaces, and `preview-iframe-element` — the element four specs asserted on —
had not existed since **v14.15.0**.

So it was not a broken suite; it was a suite for a different application. Repair meant rewriting 54
specs against the current UI, which is days of work whose output a fresh suite would supersede anyway.

**The root cause is the part worth keeping: it was never in CI.** `grep -rn e2e .github/workflows`
returned nothing. Running it required a full `npm run package` first, so nobody ran it locally either.
A suite that nothing executes cannot fail, so it rots silently while continuing to look like coverage —
which is worse than no coverage, because it answers "are we covered?" with a yes. That is the same
concern as _Suite sensitivity_ below, arrived at from the opposite direction.

**If a future suite is written:** wire it into CI on day one, before writing the second spec. Coverage
that is not executed on every push is a liability with a plausible face. `git log` has the old suite if
its scenarios are useful as a starting list.

---

## Account bans — SHIPPED 2026-08-19, recorded for the scope decision

_The reasoning is here rather than in the CHANGELOG because the interesting part is what a ban
deliberately does NOT do, and that will be re-litigated the first time someone asks why a banned user
can still use the app with their own key._

**Scope: Atlarix Core spend + the account. Not BYOK, not local models.**

The tempting version blocks everything. It cannot be built honestly. Atlarix runs offline by design —
BYOK and Ollama need no server of ours — so a client-side refusal to run a turn with the user's own
key is bypassable by an older build, a patched build, or simply no network. Shipping it would mean
claiming an enforcement we do not have, and the first person to notice would be the banned user.

So the line is drawn at what is genuinely server-side:

- **The proxy** returns 403 `account_banned`. Nothing a client does gets past it.
- **The account** refuses to proceed and offers Sign out.

And the UI says the rest still works, because it does. That is not a loophole being advertised; it is
the difference between a policy and a bluff.

**Why the check rides `get_credit_balance` rather than being its own RPC.** The proxy already reads
the wallet on every request. Folding the ban into that read costs zero extra round-trips and inherits
the TTL in the proxy's `balance-cache.ts`, which becomes the honest bound on how fast a ban bites. A separate
RPC would have doubled the per-request Supabase traffic to answer a question that is almost always
"no". It is deliberately NOT in `debit_wallet`: tokens already consumed should still be billed, so the
gate belongs at the start of a call.

**Why "at next sign-in" was never acceptable.** A ban that waits for a re-login is not a ban — a
signed-in user with a valid JWT could work indefinitely. Two mechanisms close that: the short cache
TTL on the proxy side, and the realtime `postgres_changes` subscription the app already holds on its own
`users` row, which pushes the flip to a live client. The second was free; the channel existed for
plan upgrades.

**Why the reason is not on `public.users`.** That row is delivered to the client verbatim by the same
realtime subscription, and `users` has a "Users can read own data" SELECT policy. A `ban_reason`
column would have handed every reason straight to the person it was written about. So `banned_at` is
on `users` (the client must know) and the reason is in `public.user_bans` — RLS on, no policy for
`authenticated`, so every non-service-role read is denied. This constraint came from the messaging
decision, not the other way round.

**Why there is no admin UI.** A real one means a new authenticated admin role, its own RLS policies,
and a surface to maintain — to serve a ban count near zero. Two SQL statements in
`docs/BAN_RUNBOOK.md` do the same job today. Revisit when the count makes it worth it.

**`isUserBanned` fails OPEN.** It is the UX half; the proxy is the enforcement. Failing closed would
lock a paying user out of their own API keys because a Supabase read blipped — punishing the wrong
person for the wrong reason.

---

## QA sub-agents — RETIRED in v14.52.0

_Shipped in v14.34.0 as the `qa` built-in agent; removed in v14.52.0 with `architect`, leaving
two built-ins, `explore` and `build`._ No reference tool ships a testing sub-agent, and the main
loop already runs the tests and drives the browser itself. Its one structural idea — a worker that
forms expectations from the REQUIREMENT, never the diff — is still the right way to prompt an
`explore` sub-agent for a review; its forced-read-only command routing (`subagent-command.ts`,
`preview.readOnly`) went with it. The old names still resolve (`BUILTIN_AGENT_ALIASES` in
`user-agents.ts`), so a habit or a stored transcript never degrades to a generic scout. The full
design is in `git log` for this file.

---

## Errors tab → Console + Network — RETIRED in v14.52.0 with the in-app agent browser

_Shipped in v14.31.0 (2026-08-16); the visible Browser panel went on 2026-09-23 and the hidden
agent browser, its capture and these tabs on v14.52.0._ The agent's only browser is now the user's
own Chrome / Edge / Brave through the Atlarix extension; it reads console and network over CDP
(`packages/extension/src/page/cdp-capture.ts`) with `browser_inspect`, and the right panel shows
neither. What outlived the implementation:

- **An empty read must never look like a clean page.** The extension carries `unavailable`
  ("we could not watch") separately from an empty list, and the desktop refuses to call it clean.
- **Capture has to start before the page loads.** `navigate`/`open_tab` open at `about:blank`,
  attach, then load — console events are pushed, and a buffer opened later misses them.
- **Nothing blocks a turn on a page error.** The harness cannot tell whose error a page reported.
  The once-per-turn runtime notice went too; console/network reads default to entries since the
  agent's last navigate (`resolveSince` in `browser.ts`), which is what `browser_test`'s baseline
  gave — and `browser_test` itself is gone.
- The CDP spike (Electron 38, 2026-08-16) and the webRequest fallback tier are in `git log`.

---

## Fork sub-agents — CLOSED, the economics do not work

_Recorded 2026-08-15, **rejected 2026-08-17** after doing the arithmetic. Kept as a record so the
idea is not re-derived. The implementation sketch was dropped from this file; `git log` has it._

### Why it was dropped

**The saving was counted once and paid every step.** A cache read is ~0.1× base input, so the note's
framing — "a fork reads the prefix instead of writing one" — is true of the worker's _first_ call
and irrelevant afterwards. Every subsequent step re-sends the whole message array, so an inherited
100k-token parent context is billed again on each step of the worker's loop: an 8-step worker pays
roughly 8 × 10k-equivalent for context it did not ask for. A cold worker's prefix is system + tools
and grows only by what it chose to read.

Fork therefore only breaks even for a **very short** worker — and a very short worker is exactly the
case where the parent should have done the work inline rather than delegating. The design collapses
on its own terms.

**Second, independent problem: the cache hit requires sharing the parent's toolset.** So a fork gets
`run_command` and the full write surface, and read-only stops being a capability boundary and
becomes a policy check at the execution funnel. That widens the least-supervised worker to buy a
discount that the arithmetic says is not there.

### What the real problem was, and the cheaper answer

Workers _do_ re-derive context the parent already has — that part was correctly observed. The fix is
the pattern this app already applies everywhere else: **pointers, not payloads.** The parent writes
the `prompt` today; what is missing is anything pushing it to hand over the `file:line` facts it has
already established. Pointers cost a few hundred tokens and let the worker read only what it needs —
the same reasoning that makes `.atlarix/skills` and project memory an index rather than a payload.
That is prompt and tool-description work, not a subsystem.

### The premise, for whoever proposes it again

`src/lib/agents/run-subagent.ts` starts every worker cold: a single user message, so each worker
re-derives context the parent already has and is a fresh cache write rather than a read. The idea
was to hand a worker the parent's history so it read the prefix instead. For Anthropic the cached
prefix is `tools → system → messages`, so a fork with a **different toolset or system header than
its parent invalidates the cache entirely** — a real fork must share both, which is what forced the
read-only question above into a policy check rather than a capability boundary.

### The inversion worth keeping — amended

The original note argued a three-posture taxonomy: fork inherits **everything** for cost, QA
inherits **deliberately little** for independence, explorer inherits **an objective**. With fork
dropped, the surviving and sharper distinction is about _input structure_, not inheritance:

> **Enumerated input for workers whose value is coverage (QA, implementer); an objective for
> workers whose value is discovery (explorer, architect). Structured output for every worker.**

Handing a discovery worker a checklist turns it into a batch reader that cannot tell you about the
item nobody thought to list.

---

## Model-context secret redaction — CLOSED, do not re-propose

_Reframed 2026-08-15, **rejected 2026-08-17**. Kept only so the argument is not made a third time._

The reframe was: a repo scanner hunts secrets it has never seen and pays >50% false positives for
it, but **we hold the user's actual secret values**, so exact-string redaction of those is
zero-false-positive with no ruleset — with ~20 vendor prefixes (`ghp_`, `sk-ant-`, `AKIA`, …) as a
second tier.

**Why that was not enough.** The zero-FP claim only covers the secrets we happen to store. Every
other secret on the user's machine — the ones in their `.env`, their CI config, their shell history
— is caught only by tier 2, and tier 2 is a hardcoded list: wrong at the edges, needing maintenance
forever, and _presenting itself as a guarantee it cannot make_. A partial redactor is arguably worse
than none, because it changes what users believe is safe to hand the agent. The owner's original
position stands: **we trust the agent and the provider with credentials, and we do not pretend to
scrub them.** That is also consistent with the deliberate decision in `lib/tools/glob.ts` that
in-workspace files including `.env` are enumerable.

Unaffected and still in place: **display- and telemetry-side** redaction —
`redactSecretsInText` (`src/lib/security/redact-secrets.ts`) on the display copy of tool output,
log lines and Sentry `beforeSend` — which scrubs high-confidence shapes on paths that leave the
user's control, and never touches the model-facing result.

---

## Suite sensitivity — is "tests pass" a claim about the change?

_Recorded earlier, moved here 2026-08-15._

There is no mutation testing, and no eval scenario where the fixture repo's suite is deliberately
wrong or incomplete. So a green run is a claim about the **suite**, not about the change.

v14.30.0 produced two clean instances: unit tests that asserted the _wrong_ dtype diagnosis and
passed, and 2,782 green tests plus a successful local package that still shipped a Windows-only
packaging break.

**Candidate approach:** eval fixtures whose suite is a trap — it passes while asserting the wrong
invariant; it reports 100% pass with zero coverage of the changed path; it makes a tautological
assertion. Score the agent on whether it _says_ the suite doesn't cover the change, rather than on
whether the suite is green.

The QA sub-agent above is the dynamic counterpart to this: it doesn't trust the suite, it exercises
the app.

---

## `h5i` — evaluated, reference only

_`github.com/h5i-dev/h5i`, Apache-2.0. Evaluated and NOT adopted._

A standalone Rust CLI that sandboxes AI coding agents in tiers (workspace / process / supervised /
container / microvm).

**Not adoptable:** it is a peer harness, not a library, and its leverage is Linux — its `process`
tier is Landlock + seccomp + namespaces, which we already ship natively, while Windows (Low IL) and
macOS (Seatbelt) get nothing from it. The container and microvm tiers would require users to install
Podman or have `/dev/kvm`.

**Worth borrowing:** the tier vocabulary, and its `supervised` tier — private netns + nftables
egress allowlist — which is a capability we lack and is genuinely distinct from write confinement.
Also its honest framing:

> _"It cannot stop an agent from putting your code in a prompt. Containment keeps the agent off your
> machine. Model egress is a separate control."_

That last point is what the QA sub-agent entry makes load-bearing: outbound requests are the first
place our write-confinement story stops answering the question.

---

## Passkeys — why Electron's Touch ID authenticator was removed, and what parity would take

**Do not rebuild this from the same premise.** The premise was: "the built-in browser should behave
like a browser, so a user who set up a passkey on a site can just sign in." Electron's
`app.configureWebAuthn({ touchID })` does not do that, and cannot. Since v14.52.0 the question
is moot: there is no in-app agent browser at all, and every page the agent opens is in the user's
own Chrome through the extension — where their passkeys already live. The account chooser that
used to be wired in `browser_view_manager.ts` went with that file.

Electron's own documentation, quoted because the wording is the whole argument: credentials are
"stored in the macOS keychain and bound to this device's Secure Enclave", Electron "generates and
persists a per-`session` metadata secret so that credentials created in one partition are not
visible to another", and they are "device-bound and are **not** synced via iCloud Keychain".

So the API enrols a **new** credential that is Mac-bound, unsynced, and scoped to Atlarix's browser
partition. It cannot read a passkey the user already has, and a passkey created through it works
nowhere else — not Safari, not their phone, not after they replace the machine. A user would
reasonably believe they had set up a passkey for the site and then find it does not exist anywhere
but inside Atlarix. That is a worse outcome than not offering it.

**It also could not ship.** `keychain-access-groups` is a provisioned entitlement; without an
embedded provisioning profile the kernel SIGKILLs the signed app on exec while `codesign -v` reports
it valid. It killed the signed v14.35.0 macOS build twice. See [`docs/TRAPS.md`](./TRAPS.md).

**Why Brave can and we cannot.** Brave does not store that passkey either — it calls Apple's
`AuthenticationServices` system provider, so macOS puts the credential in iCloud Keychain, shows its
own Touch ID sheet, and syncs it. Two things block that path for us, and the second decides it:

1. Using the system provider for **someone else's** relying party needs
   `com.apple.developer.web-browser.public-key-credential` — a requested, browser-vendor entitlement,
   not a portal toggle. (For a domain you own, Associated Domains suffices; that is not our case.)
2. **Electron exposes no such hook at all.** Its only WebAuthn entry point is `configureWebAuthn`.
   So even with Apple's grant there is nowhere to plug it in without upstream Electron work.

A native addon does not route around either: the gate is on the API's browser mode, and a
dependency cannot grant an entitlement. Overriding `navigator.credentials` from a preload and
proxying to a native module would mean shipping credential-API interception on arbitrary
third-party sites and reimplementing a spec browsers implement natively — enormous scope, and a
serious attack surface exactly where getting it subtly wrong hands over someone's login.

**What is actually reachable, and what shipped:** the roaming path. A security key, or the
hybrid/QR flow where the user scans with the phone that already holds the iCloud-synced passkey —
the _same_ credential Brave would have used. Both go through Chromium on every platform and need no
entitlement. The work that made that usable is the `select-webauthn-account` chooser: WebAuthn is
not an Electron permission type, so a multi-credential request had nothing listening and the page
hung for ever, and declining outright meant a security key holding two credentials could never be
used. That chooser was the feature while the in-app browser existed; **superseded in v14.52.0** —
the in-app agent browser, the chooser and `webauthn-notice.ts` are gone, and the user's own Chrome
handles every WebAuthn flow natively.

**A trap in the adjacent copy:** npm packages exist for macOS Touch ID (`LocalAuthentication`
wrappers). They prompt for a fingerprint and report success. That is not a WebAuthn assertion — it
produces no signed challenge, so the site has nothing to verify. "Touch ID worked" and "the user
proved possession of a credential the site trusts" are different claims.

## Permission surface — the audit's answer, kept after the report was deleted

`docs/PERMISSION_SURFACE_AUDIT_v14.26.0.md` was report-only and said of itself "deleted once
acted on". Both of its findings are now settled, so the file is gone (recover from git if the
working is ever wanted). What must not be re-derived:

- **The surface is layered, not duplicated.** Four duplication hypotheses went in and all four
  were refuted by the code: every mechanism answers a question no other one answers, and where
  two gates look alike the modules' own headers say which is the boundary and which is UX. The
  owner's question was "are we overcomplicating this by copying Codex and Claude Code", and the
  honest answer was no. Do not re-open it without new evidence.
- **`guard.ts` is not a permission mechanism at all** — schema validation, a `TOOL_ERROR` catch,
  Sentry breadcrumbs and `canonicalizeParamAliases`. It passes `__permission_required` through
  untouched and decides nothing about access. The name and its folder invite exactly this
  confusion, which is why it is written down.
- **Complexity is concentrated, not spread**: `interceptor.ts` is still by far the largest file of
  the surface. If anything here is overcomplicated it is that file's internal structure,
  and deleting _modules_ cannot touch it. Not a task — there is no observed failure — but it is
  where to look first if one appears.
- The audit's other finding (`ask` rules compiled, matched, logged and never enforced) **was
  acted on in v14.26.0**: there is no `ask` list any more, and a file containing that key is
  warned about rather than silently ignored (`lib/tools/permissions/ruleset.ts:17`).

## An "always allow" must describe exactly what it grants — 2026-08-21

Adopted from Claude Code v2.1.236 ("display text and 'don't ask again' options now always match what
a grant would cover, and 'don't ask again' is withheld when contents cannot be fully displayed"),
because we had the same defect in a path that happened to be unreachable.

`write_multiple_files` carried an ARRAY preview. `queueEntryFromPermission` took `files[0]` for the
path and content, so the card rendered ONE file's diff while approving executed every write in the
batch; and `permissions/handlers.ts` read `.path` off that same array, got `undefined`, and saved
**no rule at all** — so "Always allow this file" was a no-op that looked like it had worked. It was
deleted rather than repaired because no tool has emitted that operation since `write_file` folded
into `edit_file` (reachability, not presence, is what made deletion the right answer).

**The standing rules, for whatever batch operation comes next:**

1. The diff shown and the grant offered must describe the SAME thing. If a request covers N targets,
   show N, or say "+N more, not shown" and drop the always-allow.
2. Withhold "always" whenever the contents cannot be fully displayed. A grant the user could not read
   is not consent.
3. Derive a saved rule's path from the entry actually being decided, never from `preview.path` on a
   shape that may not have one. A rule that silently fails to save is worse than no button: the user
   believes the decision is recorded and it is not.
4. Where a preview shape feeds a CONTAINMENT check rather than a card, key the branch on the shape and
   keep it — `targetPathsForOperation` and `extractRelativePathsFromPreview` both retain their
   array branches for exactly this reason. An unrecognized array falling through to a per-operation
   switch extracts no targets, and no targets means the check passes by having nothing to check.

## Smaller items from the 2026-08-15 upstream review

Noted, not scheduled unless marked. Sources: opencode `v1.18.17`, claude-code `v2.1.229` / `232` /
`233`.

- **Native PDF document parts — SHIPPED.** Capable models now receive the PDF itself, gated per
  MODEL from the models.dev `pdf` input modality rather than per provider; local extraction stays
  the fallback (`pdf-native-parts.test.ts`).
- **`run_command` memory/CPU containment.** Claude Code added a Linux memory cgroup so a runaway
  build can't stall the session. The stronger version for us is **Windows Job Objects**, which also
  fixes orphaned grandchildren on cancel — a classic Electron bug worth checking regardless.
- **First-class `llama-server` detection** beside Ollama and LM Studio. It is already reachable as
  a custom OpenAI-compatible endpoint, just undiscoverable. The real payoff isn't the connection —
  it's that `/props` reports the true `n_ctx` and chat template, retiring the guesswork in
  `resolve-model-context-limit.ts` / `context-window-heuristics.ts`. Wrong context limits on local
  models are a silent correctness bug.
  - **Embedded inference via `node-llama-cpp` is NOT recommended.** We have the precedent — local
    Whisper on ONNX, with a worker thread and a WebGPU/WASM fallback — and know what it cost: three
    diagnoses before the device×dtype matrix settled it, and it was deleted outright in v14.50.0. Inference multiplies that — native module per platform × ABI on
    top of better-sqlite3/node-pty/keytar, Metal/CUDA/Vulkan backends, a 4–8GB download — for a
    model still weak at agentic tool-calling. Ollama already solves this for whoever wants it.
- **Per-model sampling defaults.** opencode fixed DeepSeek V4 Flash specifically; GLM tool-calling is
  genuinely temperature-sensitive, so this is a quality lever on the Core path. Re-check it against
  the current lineup (`core-models.json` in `atlarix-releases`): some models on it reject
  `temperature` outright (see `responses-request.ts` in `atlarix-proxy`).
- **Route chore calls to the cheapest available model** — session titles, compaction summaries,
  commit messages. They don't need the top tier. Paid Atlarix Auto already does this on the proxy
  (`paid-auto.ts` routes on a `purpose` hint: title, compaction, summary…); pinned Core tiers and
  BYOK still send chores to the chosen model. Same saving as embedded inference with no new
  dependency.
- **Malformed tool args.** Claude Code fixed a hard crash on a non-string `glob` / `file_path` /
  `command`. We explicitly target weak and local models, which emit `file_path: ["a","b"]`
  regularly — worth confirming a schema rejection returns a correctable tool error rather than
  killing the turn. Our stated principle already covers it: guards guide via the result channel,
  never dead-end.
- **Windows path-validation matrix — RESOLVED as "not doing", 2026-08-21.** Upstream (Claude Code
  v2.1.234) closed an NTLM credential-leak vector where the NT `\??\` device prefix bypassed UNC
  validation, and this note proposed a matrix of our own: `\??\`, `\\?\UNC\`, 8.3 short names
  (`PROGRA~1`), `C:relative`.
  It was built — a guard in `resolveToolTargetPath`, covering all four file tools at one choke point —
  and removed the same day on the owner's call. The finding was real: `read_file` auto-allows any
  absolute path with no approval card, and `path.isAbsolute` is true for `\\host\share\x` on Windows.
  The reasons against: it is Windows-only, needs an attacker-reachable SMB host, and above all it is
  **partial** — `run_command` can still reach a UNC path, and closing that needs the sandbox, which on
  Windows is Low IL (`NO_WRITE_UP`, reads up permitted by design). opencode has no such guard either;
  its only UNC handling is case-normalisation for display paths.
  **What still stands:** `safeRelativePathUnderWorkspace` has rejected UNC on the RELATIVE branch for
  years and is untouched — only the absolute branch is unguarded. The 8.3-short-name and `C:relative`
  cases were never examined at all. Re-open with the read-deny work, which would cover both tools at
  once rather than half of one.
- **Nested-repo trust.** Upstream fixed nested git repos inheriting trust from a parent directory.
  This note used to name the clone dialog as our re-entry path. That dialog was deleted in
  v14.41.0 — and the threat did NOT go with it. It got slightly worse: cloning is now done by the
  agent running `git clone` through `run_command`, which is the ONLY route left, so a repo arriving
  mid-session is now the normal case rather than the unusual one. The shape is unchanged: the
  cloned repo ships `.atlarix/hooks.json`, which is `/bin/sh -c`'d on every tool call. The original
  hole was closed with authority-file approval — the open question is still whether a repo cloned
  _mid-session_ re-triggers that approval, and it is now worth more than it was.
- **Approval notifications — SHIPPED.** An OS notification when the window is unfocused and a turn
  is waiting on the user (`showAgentNotification` in `permissions/handlers.ts`).
- **Session-scoped web fetch cache — SHIPPED** as the `read_url` cache in `lib/tools/web.ts`, which
  also dedupes concurrent fetches of the same page by parallel sub-agents.
- **Signal, not a task:** Anthropic removed TodoWrite/task tools on Opus 4.8, Sonnet 5, Fable 5 and
  newer — modern models don't need the scaffold — and deleted the startup tip suggesting custom
  subagents. That is upstream arriving at our own net-less-surface filter. It argues for an eval on
  whether the `plan` tool helps or hurts on Core models, not for deleting anything on vibes.

## No host-specific integrations — 2026-09-02

The owner's rule, in their words: **"hardcoding does not help anyone at all."** It settled two
deletions in v14.41.0 and is the reusable part.

A "Clone repo" button that runs a GitHub device-code flow and stores a GitHub API token is not a
cloning feature. It is a GitHub cloning feature, and GitLab, Bitbucket, self-hosted and plain SSH
can never reach it. The same for an Automations trigger that polls the GitHub API for a new PR: the
capability is "poll an API for new information, a mention, or a finished job", and that capability
is identical on every host.

**The test to apply.** For an integration, ask what the generic capability is, then ask whether we
already have it. If we do, the host-specific version is not a feature — it is a hardcoded instance
of one, and it carries costs the generic path does not: a credential to hold, refresh and leak; a
poller to maintain; and a UI that promises a shape only one vendor has.

- Cloning → `git clone` via `run_command`, using the user's OWN auth (SSH keys, credential helper,
  `gh`/`glab`). Atlarix holds nothing. Strictly more capable than what was deleted.
- Polling → an MCP trigger reaches any API; a schedule plus a command covers the rest.

**What this is NOT an argument against.** Signing in with GitHub stays: that is an identity
provider, not an integration, it goes through Supabase, and Supabase holds the OAuth credentials
server-side. Nor is it an argument against the Atlarix Reviewer GitHub App, which IS a
GitHub-shaped product because it reviews GitHub pull requests.

**The cost of getting this wrong is not just the dead code.** The deleted `githubAccessToken` had
already produced a real user report: people conflated it with signing in to Atlarix, because two
GitHub credentials existed for unrelated reasons and only one of them mattered.

## An alias must be honoured where calls are DISPATCHED, not where names are looked up — 2026-09-02

`ToolMetadata.aliases` exists so a retired tool name keeps working: a stored transcript that
contains it still renders, and a model that learned it still gets through. `tool-name-aliases.test.ts`
pinned that contract when `preview_test` became `browser_test`, and it passed — because it tested
`ToolRegistry.get` and `resolveName`, which is where the alias map lives.

**No dispatch path honoured it.** Both paths look a tool up in the resolved ToolSet first, and a
ToolSet advertises canonical names ONLY — that is the other half of the alias contract. So:

- **text-tool path** — `if (!tools[toolCall.toolName])` → `Error: Unknown tool "browser_navigate"`,
  reached before `ToolRegistry.execute` could resolve anything. Fixed in v14.41.0 by resolving for
  the lookup. This is the path that mattered most: text tools are the fallback for models WITHOUT
  native tool calling, i.e. exactly the population most likely to emit a name it learned.
- **native path** — the provider SDK validates the call against the tools it was handed, so an
  alias fails before any Atlarix code runs. Left as-is deliberately: the model has only the current
  name in front of it, and a loud failure it can retry beats a repair hook.

**The second-order defect, which is the more interesting one.** Making the alias executable
_created_ a security regression, because a permission rule is a plain string match with no idea
aliases exist. Two directions, both live:

- A rule denying `browser` did nothing against `browser_navigate` — the strings differ.
- Canonicalising at the dispatch site instead would have silently voided every rule a user had
  already written against an old name.

So the gate evaluates BOTH the as-called name and the canonical one, first deny wins — adding a
name can only tighten it. And the canonicalisation happens in exactly one place, the gate, because
only the gate sees both strings.

**What the tests taught here.** A registry-level alias test is not evidence that a call by a retired
name works. Test the DISPATCH, through the funnel, or the assertion is about a lookup nobody
performs. Both fixes were verified by reverting each one and watching a specific eval fail.

## Lint caught what four test files could not — 2026-09-02

Re-keying the browser activity labels from tool-name dispatch to `args.action` dispatch left the
function's trailing `return null` unreachable. Every label test passed, because they all pass
browser tools. `oxlint`'s `no-unreachable` was the only signal, and the question it forced was the
useful one: if this can never return null, what happens to a non-browser tool? (Nothing — the
`BROWSER_TOOLS` guard at the top is the null path. But that had to be checked, not assumed, and
the answer is now a comment where the missing `return` used to be.)

## A fixture that outlives the shape it fixtures — 2026-09-02

MCP servers have been workspace-scoped since migration 0049, which deleted every `scope = 'global'`
row; both writers in `mcp_handlers.ts` hardcode `"workspace"` (the one `"global"` in that file is a
legacy parameter type immediately overridden on the next line). So the `scope = 'global'` branch in
`listConfiguredMcps` and `mcp_call`'s lookup could never match a real row — and a workspace-less
caller got an empty list by accident rather than by design.

Two evals still passed, because both inserted their fixture directly with `scope: "global"`. The
fixture was the only thing in the codebase producing that shape, so the tests were verifying that
dead code still worked rather than that the feature did.

**The general shape.** A test that constructs its own rows can assert on a state the product has
retired. When a query change breaks such a test, the first question is what shape the FIXTURE
builds, not whether the change is wrong. Both evals now bind to `ctx.appId` with
`scope: "workspace"`, which is what a real server looks like.

**And on the verification itself:** this was checked by `git stash`-ing the whole change and
re-running the two evals, which is the only way to tell "my change broke this" from "this was
already red". They passed on the stashed tree, which is what made it worth chasing rather than
dismissing.

## Mobile tools deleted — 2026-10-23 (15.11)

The `mobile_inspect` + `mobile` pair (adb / simctl behind refs) is gone, with no skill in its
place. Owner's reason: it was a stack of per-endpoint workarounds (`adb exec-out`, monkey's
exit 251, simctl's `-` path) that are not fixed forever and that models handle differently —
like customising one API when there are many. A model drives an emulator with `run_command`
(the same `adb`/`xcrun simctl` a person would type, inside the sandbox) and looks at a
screenshot file with `view_image`. Before adding a device tool back, show a failure those two
cannot get past.

## An error message is part of the tool's contract — 2026-09-02

`browser({action:"fill"})` on Wikipedia's search box threw **"Illegal invocation"**. The cause
was small: the handler chose its native `value` setter by elimination —
`el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype`
— and a ref can point at a WRAPPER rather than the field. A native accessor rejects a receiver
of the wrong type, so the wrong guess THREW where a normal property assignment would have
degraded quietly.

What the failure cost is the interesting part, and it was all in the message. From the observed
transcript: retry the identical call, retry again, try a click-then-fill batch, conclude "the
entire action pathway is broken for refs on this page", then work around it by clicking a
different element until a fillable input appeared. Three turns, and a correct diagnosis was
never available, because "Illegal invocation" names a JavaScript invariant rather than anything
the model could act on.

So the fix is two things, and the second matters more:

1. **Walk to the field.** `el.matches(fillable)` → else the contained one, else the ancestor.
   The accessibility snapshot labels Wikipedia's wrapper "search input" because that is its
   ROLE; the node is a div with the input inside. Component libraries do this constantly.
2. **Say what the element is and what to do.** `<div> is not a field and contains none
(role="combobox"). It may be a wrapper that reveals the real input when clicked: try
action:"click" on this ref, then re-read the page…` — which is exactly the recovery the
   model eventually found by trial and error.

**And a lesson about reading transcripts.** That model concluded both `click` and `fill` were
broken. Only `fill` ever was: the batch it cited had failed at its fill step. There is exactly
one `.call` site in the entire browser tool, which settled it in one grep. A model's
post-mortem is a hypothesis, not evidence.

## A missing allowlist entry may be the decision, not the bug — 2026-09-02

Compaction was invisible: the agent paused for several seconds mid-turn to summarise its own
context, and nothing on screen said so. The obvious cause was `chat-activity-normalize.ts`
omitting `"compaction"` from `VALID_TYPES`, so the event normalised to `null` and never reached
the atom — and `compaction-activity.ts`'s comment saying that type "drives the raw-IPC banner
(CompactionProgressStrip)" made that reading very plausible, since no such component exists.

The omission is deliberate. The main process emits BOTH a `compaction` banner event and a
parallel `background` one for the same moment; admitting the banner type would put two rows in
the activity atom for one event. `compress-context-persistence.test.ts` pins the drop
explicitly, as the Bug 1c contract, and failed the moment the "fix" landed — which is the test
doing precisely its job.

The pill therefore reads the `background` row matched by label, the same shape
`useCompactionTokenVisuals` was already using. One channel, already working, no new type. The
stale comment is corrected, because a pointer at a deleted component is what made the wrong
answer look right.

**The general form:** when a value is absent from an allowlist and adding it would fix your
symptom, look for the test that pins the absence before you add it. If there is one, the
absence is a decision and your symptom has another cause.

## `success: false` has three meanings, and the card must tell them apart — 2026-09-02

Reported from the packaged app: two rows with a green ✓ in the header and a red **"Tool
failed"** underneath. Both were the system working correctly.

Read back out of `session_messages` (the log records nothing structured about tool results —
the DB does):

```json
{"success":false,"status":"noop","tokensBefore":7474,"tokensAfter":7474,
 "summary":"Already compact: history is 7474 tokens (~39% of the 19200-token usable
            budget) — nothing worth compacting. No action needed."}
```

```json
{"success":false,"loop_guidance":"You have made this exact read_url call 3 times in a row
  with identical input… This call was NOT executed. Do not repeat it."}
```

`envelopeFromObject` read `error`, then `message`, then gave up on the literal string
`"Tool failed"` — and neither payload has either field. So the card **discarded a better
explanation than it could possibly invent, and replaced it with an assertion that was false.**
A generic fallback is not merely uninformative here; it actively misinforms.

**The three meanings.** `success: false` is the right signal for the MODEL in all of them —
the work did not happen — and only one of them is an error:

|               | Marker                    | Card       |
| ------------- | ------------------------- | ---------- |
| It broke      | an `error` the tool wrote | red        |
| Nothing to do | `status: "noop"`          | plain text |
| Declined      | `loop_guidance` present   | plain text |

Both non-error cases are marked EXPLICITLY. Nothing here infers "did anything happen" from the
shape of a result, because that inference is how you get a confidently wrong label — which is
what the header was already doing: the label map says "Context compacted" for
`compress_context`, so the row claimed the one thing that had not occurred. It now says
"Context already compact", reusing the wording the compaction banner has had since v14.8.11 so
the two surfaces cannot drift.

**And the sentinels.** `ToolRegistry.execute`'s failure branch fills in
`error: fail.error ?? "TOOL_ERROR"` and `message: fail.message ?? "Tool returned an error"`.
The first version of this fix read `error` first and surfaced `"TOOL_ERROR"` — worse than
"Tool failed", because it looks like a code you could look up. They are skipped in favour of a
real field, and remembered only as a last resort so an unexplained failure is not a blank card.

**Two general shapes worth keeping.** A fallback string in a display path is a claim; make it
the last resort after every field a tool might have written, and make it say only what you
know. And when a card renders wrongly, the payload is in the DB — the text-tool path stores
the handler's raw return while the native path stores the registry's wrapper, and reasoning
about which one you are looking at is slower and less reliable than querying it.

## Unifying an implementation does not unify its notifications — 2026-09-02

v14.39.0's headline was that compaction had been THREE implementations with three thresholds
and two summarizers, and became one compactor with three triggers. That consolidation was
correct and is still correct. What it did not touch was how compaction ANNOUNCES itself, and
that had quietly become the same mess one layer up: six hand-rolled `safeSend(…,
"chat:activity", …)` calls across four files, emitting three different labels for one event.

| Site                                 | Emitted             | Label                                                |
| ------------------------------------ | ------------------- | ---------------------------------------------------- |
| `context-assembly.ts` ×2 (automatic) | `compaction` only   | "Context compacted automatically"                    |
| `ask-branch.ts` ×2 (model)           | `compaction` only   | "Context compressed"                                 |
| `build-branch.ts` ×1 (model)         | `compaction` only   | "Context compressed"                                 |
| `compaction-activity.ts` ×2          | both, conditionally | "Context compressed" / "Summarizing in-task context" |

**The inconsistency was the bug, not a tidiness complaint.** `chat-activity-normalize.ts` drops
`type: "compaction"` deliberately (one moment must not produce two activity rows), so only the
sites that ALSO emitted a `background` event were visible. The automatic pre-dispatch trigger
did not — making the compaction a user never asks for, the one most likely to read as a hang,
the only one with no indicator at all. Reported with the context ring pinned at 100% and
nothing on screen. `emitModelCompactionActivity` had the same symptom from a different cause:
its `background` event sat inside `if (outcome.success)`, so a no-op emitted only the dropped
type.

`emitCompactionActivity(sender, chatId, {id, trigger, status, noop, detail})` is now the only
emitter. Two details are deliberate:

- **It always sends both events.** Not "the caller decides" — that choice is what produced the
  gap, and no call site has a reason to want one without the other.
- **The label is DERIVED from trigger + phase, never passed in.** A per-site label string is
  precisely how three variants drifted, and a label is not free-form here: the renderer matches
  it against `/summariz|compress|compact/i`, so a site inventing new wording can silently opt
  itself out of the UI. Deriving it makes that impossible.

**The general shape.** After consolidating an implementation, ask what still talks ABOUT it.
Telemetry, activity events, log lines and labels tend to be written at the call site, so they
survive a refactor that unified everything underneath them — and they are the layer the user
actually sees, which means the drift shows up as "the feature doesn't work" rather than as
duplication.

---

> Moved out of `docs/TODO.md` at v14.46.0. None of it is scheduled; all of it is
> reasoning somebody will otherwise re-derive.

## 🖥️ QUEUED AFTER THE EXTENSION — the CLI (brief written 2026-09-11)

**Superseded on ordering 2026-09-12 — the EXTENSION went first, and has since shipped.**
Everything below stands as the CLI brief; only its position in the queue changed. The CLI
remains the cheaper build (name held on npm), so none of this expires.

**What already exists.** `atlarix` is published on npm (PROPRIETARY, `packages/headless`),
driving the REAL agent loop through a small Electron stub — `src/headless/` is a driver,
not an implementation. The header of `src/headless/atlarix-headless.mts` already reserved
room for an interactive mode and shaped the arg parsing so the published binary never has
to change. **So this is a TUI,
auth and billing job, not an agent job.**

**The download number is not adoption — measured, do not repeat the mistake.** 794 in
30 days looks like traction and is not: the package was first published 2026-09-01, so
it is days old, 518 of those landed on publish day across four versions at once, and
superseded versions from ten days earlier still pull 12-15/week each. That even spread
across versions nobody would install deliberately is registry mirrors and scanners
walking every version. Some of the rest may be our own benchmark containers. npm
publishes NO source data, so nobody can attribute it further. Treat real users as zero.

### Auth — loopback PKCE (RFC 8252), the Claude Code shape

CLI opens a loopback server, sends the user to atlarix.dev, exchanges the code itself.

- **Enumerate 2-3 fixed ports, never a wildcard.** Register each byte-identically in
  Supabase Redirect URLs and pin it with a test, because **GoTrue silently falls back to
  Site URL on a mismatch** — no error, just a bounce to the website with no session. That
  is the trap `oauth-redirect-allowlist-match.test.ts` already exists for.
- **Refresh the access token PER REQUEST, not per session.** `get_model_client.ts` re-reads
  `getSession()` on every call precisely because a static ~1h token freezes into a long
  agentic turn. Skipping this means hour-long runs dying at the 60-minute mark.
- **Credential at rest is the one genuinely new decision.** The desktop encrypts with
  Electron `safeStorage`; a CLI has no equivalent. OS keychain (`security` / libsecret /
  wincred) or a `0600` file under `~/.atlarix/` — a plaintext refresh token in a dotfile is
  a weaker posture than the app has today, so choose it, do not default into it.
- BYOK is already done (`--provider-id`, `--provider-url`, `ATLARIX_HEADLESS_API_KEY`).
  Core is the only new path: Supabase JWT as bearer to the proxy.

### Payments — no new API is needed

The proxy's error contract already carries it: `402 {error:"insufficient_credit",
required_cents:N}` — which since Atlarix Auto also says whether free Auto is on offer
(`free_available`, `consent_required`) — plus `403 account_banned`, `model_not_permitted`,
`core_unavailable` and `free_usage_limit`. The CLI renders "you are $X short → atlarix.dev/account" straight
from that. `GET /v1/models` (unauthenticated by design) gives the live Core lineup.

### TUI — TypeScript + Ink, green as an ACCENT

- **TypeScript, linked directly against the loop.** A TUI in another language forces a
  process boundary between terminal and engine — an architectural cost paid for cosmetics,
  and a second place for state to desync. Ink reuses the renderer's React fluency.
- **Do not clone opencode's TUI.** Our own recorded filter says CC and opencode are
  references, not goals — and a cloned look forfeits the one thing a CLI gives free: being
  recognisable in a screenshot.
- **NEVER paint the background black.** Measured contrast for the brand green
  (`--primary` dark = `#10b981`): 8.28:1 on black (AAA), 6.57:1 on `#1e1e1e` (AA), but
  **2.54:1 on white — FAIL**. Painting black fights the user's theme and kills terminal
  transparency; not painting strands light-terminal users. So: green accents on the
  terminal's own background, `#047857` (5.48:1) or `#065f46` (7.68:1) as the light-terminal
  variant, `COLORFGBG` detection, honour `NO_COLOR`, 256-colour fallback. The phosphor look
  comes from box-drawing borders, not a black fill.

### Distribution — one package covers more than it looks

- **npm: done. bun: nothing to do** — `bun install -g` / `bunx` resolve from the npm
  registry, same package. **pip/PyPI: skip** — a Python wrapper around a Node CLI buys a
  listing and costs a second release train.
- **"sudo" is not a channel.** People `sudo npm i -g` because the global prefix is not
  writable; the fix is documenting a version manager, or shipping a standalone binary.
- **Homebrew is free but homebrew-core is CLOSED to us while proprietary** — core formulae
  must carry a DFSG/OSI licence, and notability is >=30 forks / >=30 watchers / >=75 stars,
  which a private repo cannot accrue anyway. Casks do accept proprietary binaries but are
  macOS-app shaped. **So: our own tap** (`brew tap AmariahAK/atlarix`, a repo named
  `homebrew-atlarix`) — free, instant, no approval, no licence test. Scoop bucket, AUR and
  a `curl | sh` installer are likewise free and self-hosted; WinGet is free with review.

### `better-sqlite3` — and why the obvious fix is the WRONG one

It is the ONLY native dependency, `external` in `scripts/build-headless.mjs`, compiled per
platform AND per Node ABI. It is why the prebuilt linux/amd64 tarball fallback exists for
musl, and why `vitest.config.mts` keeps a separate Node-ABI copy under `tests/infra`. Every
distribution channel inherits that fragility.

**The tempting fix is `node:sqlite`, and it is blocked. Measured 2026-09-11, so nobody
re-derives it.** `drizzle-orm@0.45.2` IS the latest, and it ships no `node:sqlite` driver —
its sqlite drivers are `better-sqlite3`, `bun-sqlite`, `durable-sqlite`, `expo-sqlite`,
`libsql`, `op-sqlite` and `sqlite-proxy`. The only generic escape, `sqlite-proxy`, takes an
**async** query callback, and our DB layer is synchronous throughout — `initializeDatabase()`
in `src/db/index.ts` returns a value, not a promise, and session persistence, provider
resolution and compaction all call into Drizzle synchronously. Making the whole app's
database layer async to solve a PACKAGING problem is the wrong trade by a wide margin.

**Do this instead: per-platform `optionalDependencies`.** Ship `@atlarix/cli-darwin-arm64`,
`-darwin-x64`, `-linux-x64`, `-linux-x64-musl`, `-win32-x64` sidecar packages, each carrying
the matching prebuilt `.node`, and let npm install exactly one. This is what esbuild, swc,
sharp and rollup all do. It needs **no code change, no ORM swap and no async refactor** —
only CI that builds the prebuilds — and it delivers the actual goal: `npm i -g atlarix`
never compiles and never fails on musl. The existing fallback tarball then retires.

Revisit `node:sqlite` only if Drizzle ships a driver for it. `libsql/node` is the other
thing worth a look, since libSQL's prebuild coverage may be better than better-sqlite3's —
but it is still a native module, so it changes the odds, not the shape.

A standalone single-file binary (Node SEA / `bun build --compile`) stays a SEPARATE, later
question: a `.node` file still has to be embedded and extracted at runtime. Do the sidecar
packages first; they solve npm, and npm is the channel that matters now.

### Banked: a second, separate argument about open-sourcing

Staying proprietary is not merely harder for distribution, it is **categorically excluded**
from homebrew-core and from several awesome-lists. That is a real cost to weigh against the
one-way-door argument for NOT rushing it: open-sourcing the CLI means open-sourcing the
ENGINE (the loop and the tools it drives — the Electron shell is the least valuable part), and you can open-source later but never un-open-source. Recommended
sequence unchanged: **ship the TUI free and closed, measure, then decide once, with data.**

---

## 🧭 Three products, one engine — the boundary that decides scope (2026-09-11)

Atlarix now has three shipping surfaces over one agent loop. Without a stated boundary they
converge, because every one of them will at some point have a good reason to grow the
others' capabilities. **The boundary is what each may TOUCH**, and it is a capability rule
rather than a positioning one, so it answers scope questions on its own:

|                 | **CLI**                                    | **Extension**                                   | **Desktop app**                            |
| --------------- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------ |
| Touches         | your files and your shell                  | your **browser session**                        | both, plus its own hidden, signed-out browser |
| Never touches   | your browser session                       | any file, any shell — **not "later", never**    | —                                          |
| Who it is for   | developers, in a repo                      | anyone with a browser, including non-developers | developers who want the whole workstation  |
| Models          | any — BYOK, local Ollama, or Core          | **Core only**                                   | any                                        |
| Atlarix account | **required** (BYOK too)                    | required                                        | **required** (BYOK too)                    |
| Distribution    | npm, own brew tap                          | Chrome Web Store                                | atlarix.dev installers                     |
| Its job         | reach and credibility in the dev ecosystem | volume, and a wider non-developer market        | the product people pay for                 |

### One subscription, one balance, four surfaces (owner, 2026-09-11)

Pro and the credit balance are **shared across desktop, CLI, browser extension and
Reviewer**. Top up once; every surface draws from that wallet until it runs out. This is
not new architecture — it is the existing model extended, and the schema already supports
it:

- **The wallet is already per-ACCOUNT, not per-product.** `credit_wallet` and
  `credit_transactions` are keyed on `user_id`, and the README states the rule: _"One
  subscription, one balance."_ The CLI and the extension present the user's Supabase JWT
  exactly as the desktop does, and the same `debit_wallet` path runs. **No wallet change,
  no new endpoint, no new RPC.**
- **The one real gap was ATTRIBUTION — BUILT 2026-09-13.** Every client sends
  `X-Atlarix-Surface` (`ATLARIX_SURFACE` in `src/ipc/shared/core_proxy.ts`, and the
  extension's `core/client.ts`); the proxy maps it through `USER_SURFACES` in
  `entitlement.ts` (unknown values fall back to `app`; `reviewer` is service-token only),
  and `20260913120000_ledger_surface_attribution.sql` widened the ledger's `source` CHECK.
  `get_credit_breakdown` groups by source, so each surface renders as its own row.
- **Why it was done BEFORE the surfaces shipped, not after.** A ledger row cannot be
  re-attributed later: spend recorded without a source is indistinguishable forever, so
  the first month of CLI and extension usage would have been permanently unsplittable from
  the app's. `core-surface-header.test.ts` pins the literal value for the same reason.
- **Refunds and clawbacks already have a trap here.** Per the money-path audit, ask whether
  a number is a delta or a running total before trusting `(kind, ref)` dedupe — adding a
  fourth source multiplies the ways two rows can collide on the same `ref`.

**Three rules that follow, and exist to stop the drift:**

1. **CLI v1 has no browser capability at all.** If it ever grows one it INHERITS the
   extension's proven page-control layer — it does not grow its own. Letting CLI v1
   scope-creep into "must also drive browsers" recreates the dependency the CLI exists to
   avoid, and means debugging browser automation in a terminal.
2. **Atlarix ships the extension no filesystem and no shell of its own — but a CONNECTOR
   the user adds may extend it. AMENDED 2026-09-14; the original is below.**

   This rule used to read: *"The extension never gets a filesystem or a shell. That is not
   a missing feature, it is the containment: the extension is the user logged into their
   bank and their email, and the absence of local execution is what bounds a
   prompt-injection blast radius."* Account-side MCP connectors retire the second half of
   that, because a remote MCP server can expose any tool it likes, including file and
   command execution.

   **Owner's decision, asked and answered 2026-09-14: no per-surface restriction.** Adding
   a connector is already an explicit act of trust, and it is what Claude and ChatGPT both
   do — their connectors are account-level and inherited by their browser extensions. A
   surface allowlist and per-tool consent prompts were both offered and both declined.

   **So the containment is now the user's choice of connector, not the platform.** Two
   things follow and neither is optional:

   * `wrapUntrustedData()` around connector metadata AND results stops being
     defence-in-depth and becomes the ONLY remaining structural boundary between a page
     the agent reads and a connector's tools. It is a prompt-injection mitigation, not a
     capability boundary, and it should never be described as one.
   * Site grants bound what the agent can TOUCH; they do not bound what it does with what
     it reads. A turn that reads authenticated mail on a granted origin and then writes it
     out through a connector is entirely inside the grant. That is the residual risk, and
     it is written here rather than left implied.

   Still true, and still the reason the first half of the rule survives: Atlarix itself
   gives the extension no local execution. Artifacts (charts, PDF, CSV) are rendered in the
   offscreen document and handed over via `chrome.downloads` — never written to a disk the
   agent can reach.
3. **A model restriction binds the LOOP, not the tool.** Whoever runs the agent loop inside
   the extension must be Core. Whoever drives the extension AS A TOOL may be any model,
   because that loop is in the desktop on the user's own key.

**An account is required on every surface, BYOK included — verified, not assumed.**
`chat_stream_handlers.ts` calls `requireAuthSession()` before every turn, so the desktop
already works this way and the CLI matches it. What BYOK buys is free INFERENCE, not
anonymity.

**The cost of that, stated once so it can be mitigated rather than argued:** it spends the
CLI's single best marketing lever. A CLI's advantage over an app is that trying it is one
command, and "log in first" is exactly the friction an app has and a CLI is supposed to
lack. Mitigate rather than reverse: make `atlarix login` a one-command browser round trip,
make it the FIRST-RUN experience rather than an error the user hits after typing a prompt,
and keep `--help`, `--version` and the model list working signed-out so the binary never
feels inert before the account exists.

**Trap already in the code.** `require_auth_session.ts` returns a SYNTHETIC session when
`ATLARIX_HEADLESS=1`, deliberately — today's headless binary is BYOK-only with no Core
metering, so it needs no login. The moment the CLI can reach Core that escape hatch must
become conditional: synthetic is fine for BYOK, but a Core dispatch has to demand a real
session. Otherwise the fake `atlarix-headless` user passes the local gate and fails later
against the proxy's `jose` verification — a confusing failure deep in dispatch instead of a
clear "log in first" at the top.

---

## 💵 Pricing — SETTLED 2026-08-26, amended since, and the code that implements it

> Owner decisions, recorded so they are not re-argued. **The live model — what is free, what Pro
> includes, who pays for Atlarix Auto — is [`docs/CORE_BILLING.md`](./CORE_BILLING.md)**; this
> section keeps the reasoning. The rule that survives every revision: **never ship a tier whose fee
> is fully consumed by bundled inference.** The fee includes _some_ inference because the older
> shape asked for two purchases before a new user's first agent turn — and that is where the funnel
> was dying.

- **The app is free, with no feature gating** (v14.45.0). The only paid thing is Core inference.
  BYOK and local models are free. The skills marketplace went in the same release, and the $1
  signup trial credit was removed 2026-09-08.
- **Atlarix Pro stays $19/mo** and includes a monthly Core allowance shared by the app, the
  extension and Reviewer; pay-as-you-go credit sits on top. Price deliberately NOT raised: $19
  sits under Cursor/Windsurf $20 on purpose, and raising it while improving it makes the win
  ambiguous. **If more revenue is wanted, the lever is the allowance size, not the sticker** —
  the sticker is what people compare.
- **Atlarix Auto (2026-09-23) is one option for everyone and the default for new installs.** The
  proxy, not the client, decides who pays: an account with a Pro allowance or credit gets paid,
  per-step-routed Auto that is never shared; an account with neither gets free Auto on OpenAI's
  shared-data tokens after a one-time consent, with a fair daily share. Pinned Core models need
  Pro or credit. Details and limits live in `CORE_BILLING.md` and the proxy's `free-auto.ts` /
  `paid-auto.ts`, not here.
- **The allowance and the mark-up are CODE, and this file must not copy them.** The allowance is
  `MONTHLY_GRANT_CENTS` in `supabase/functions/handle-lemon-webhook/index.ts`; the mark-up is
  `MARKUP` in `atlarix-proxy/src/server.ts`. This section once copied both and was wrong both
  times — it quoted an allowance the webhook had already raised, and described a mark-up that
  netted far less as "40%" for months.
- **A mark-up is not a margin.** It multiplies COST: at mark-up `m`, gross margin on credit spent
  is `(m − 1) / m`, and LemonSqueezy's cut of money-in comes off before that, so the net at FULL
  consumption is lower still. It is identical on Pro and PAYG, because both hand over $X of credit
  for $X paid — the mark-up, not the price, sets the margin on both. Realised margin sits above
  the full-consumption figure, because the allowance expires monthly and most subscribers
  underspend.
- **The ceiling on the mark-up is BYOK, which we give away and price-tag per reply.** The app
  shows the cost of every turn, so a user who can read that number and compare it to provider
  list price has a free escape hatch built into the same dropdown.
- **Do NOT publish the allowance figure.** Say what it buys, never the dollars — the rule and its
  reasoning are at the top of `src/shared/billing_copy.ts`.
- **REVIEWER IS INCLUDED IN PRO. There is ONE product** (2026-09-08). The separate Reviewer
  subscription was withdrawn because it asked a customer who had already paid $19 to pay $19
  again. **The code is the proof, not this file:** `handle-lemon-webhook/index.ts` declares
  `MONTHLY_GRANT_CENTS: Record<"pro", number>` — one product, no classification step — and
  `20260908130000_drop_reviewer_subscriptions.sql` dropped `reviewer_subscriptions`,
  `reviewer_entitlement_service` and `upsert_reviewer_subscription_service`.
- **So there is one wallet, one allowance and one grant row per user.** `credit_grants` is
  still keyed `(user_id, product)` and `spend_from_wallet` still takes a preferred product —
  both are correct shapes to keep, and they are why a second product would need no schema
  change. But only `'pro'` is ever written today, so `debit_wallet_service`'s
  `CASE WHEN p_source = 'reviewer' THEN 'reviewer' ELSE 'pro' END` never takes its first
  branch: a reviewer debit finds no `'reviewer'` grant, falls through the "any other
  allowance" loop, and spends the Pro allowance. **Right outcome, reached by a path that
  reads as though two products exist.** Do not "fix" it — it is the correct shape if a second
  product ever returns — but do not read it as evidence that one does.
- **What is still true from the old reviewer pricing, and worth keeping:** unlimited repos,
  because **nobody charges per repo** and per-repo punishes microservice teams who have the
  most PRs and the most to gain; and it is safe to give away because a dev's PR output is
  bounded by being human, regardless of repo count. Seats become an upgrade when a team asks
  for one invoice — `github_installs` already ties an installation to exactly one account, so
  that needs no seat detection, no LS quantity API and no reconciliation job. The old "no
  open-source exemption" line (withdrawn 2026-09-04; the spec now lives in the
  `atlarix-reviewer` repo) is partly overtaken: the reviewer sends
  `X-Atlarix-Repo-Visibility: public` for a public repo, and the proxy offers free Auto to that
  request when the account has nothing to pay with. A private repo still needs Pro or credit.

**The credit-grant machinery (built 2026-08-26):**
`supabase/migrations/20260826130000_subscription_credit_grants.sql` — `credit_grants` (one row per
user × product), `spend_from_wallet`, `wallet_spendable`, `grant_monthly_credit_service`,
`clear_monthly_grant_service`, and grant-first rewrites of `debit_wallet` /
`debit_wallet_service` / both balance reads. `handle-lemon-webhook` handles
`subscription_payment_success` and the allowance grant/clear. (The reviewer-subscription
migration, checkout mode and entitlement gate built alongside it were removed 2026-09-08.)

**Traps found while building it, worth not rediscovering:**

- **`balance_cents` in every RPC result now means SPENDABLE total** (allowances + purchased), not the
  purchased column. That is what makes the change need no client edits: the proxy's pre-flight gate,
  the app's balance display, `--doctor` and the low-balance nudge all read that one key through an
  RPC, and nothing anywhere reads `credit_wallet` directly. Verified across all three repos before
  relying on it.
- **An allowance is SET, not added, so `(kind, ref)` idempotency cannot protect it.** That index makes
  repeated INSERTs safe, which assumes deltas add up. A replayed grant has to be refused _before_ any
  arithmetic — hence `credit_grants.ref`, checked first.
- **One `granted_cents` column cannot serve two products.** With SET semantics, whichever subscription
  renews second silently wipes the other's allowance. The per-(user, product) row makes it
  structurally impossible, which is why it stays even with one product.
- **`subscription_payment_success` carries a different payload shape.** Its object is an INVOICE, so
  `event.data.id` is the invoice id and the subscription comes from
  `attributes.subscription_id`. The `subscriptionId` every other case uses is the wrong value here.
  The invoice id turns out to be the ideal per-period grant ref.
- **A missing `switch` case is completely silent.** `default:` logs and 200-ACKs, which is right for
  LemonSqueezy (a 4xx retries forever) and is exactly why the absent
  `subscription_payment_success` branch went unnoticed while the event was already subscribed on the
  LS side. If a paid behaviour does not fire, look for a missing case first.
- **A CHECK-constrained outcome column needs widening with the code.** `review_history.kind` would
  have raised 23514 on a path whose whole job was to decline quietly. (That outcome,
  `not_subscribed`, is now historical only.)

**How to apply the NEXT one, because this is not `db push`.** The local migration history is not in
sync with hosted, so migrations go through the SQL editor and `supabase migration list --linked` is
how you confirm one landed. `verify_jwt` is now DECLARED per function in `supabase/config.toml`
(since 2026-09-08) — before that it lived only in the dashboard and a deploy could re-enable it on
`handle-lemon-webhook`, which would break every webhook (LemonSqueezy sends no JWT).

**Refunds shipped in v14.38.0.** Kept as a pointer because this is where someone reading the
credit-grant work will look for it: the traps are in the shipped index, and
`refund_grant_service` is the fifth service RPC.

---
