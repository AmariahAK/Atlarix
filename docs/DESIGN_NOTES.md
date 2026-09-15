# Atlarix design notes

Work that has been **designed but not scheduled**. Each entry exists so the conversation resumes
cold instead of being re-derived. [`docs/TODO.md`](./TODO.md) carries a one-line pointer per entry;
this file carries the reasoning.

Nothing here is a commitment. An entry graduates to TODO when it becomes active work, and to
[`docs/CHANGELOG.md`](./CHANGELOG.md) when it ships.

**Last updated:** 2026-08-19

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
`balance-cache.ts`'s 3-second TTL, which becomes the honest bound on how fast a ban bites. A separate
RPC would have doubled the per-request Supabase traffic to answer a question that is almost always
"no". It is deliberately NOT in `debit_wallet`: tokens already consumed should still be billed, so the
gate belongs at the start of a call.

**Why "at next sign-in" was never acceptable.** A ban that waits for a re-login is not a ban — a
signed-in user with a valid JWT could work indefinitely. Two mechanisms close that: the 3s cache TTL
on the proxy side, and the realtime `postgres_changes` subscription the app already holds on its own
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

## QA sub-agents

_Recorded 2026-08-15. The agent's own QA pass: after building something, spawn workers that
exercise the running app and report findings._

**It is not stress testing** — it is acceptance and exploratory QA. If it is named or prompted as
"stress test", the model will fire a thousand requests at a dev server and call that work.

### Shape

- **Surfaces, not roles.** The main agent declares up to **3** surfaces, each
  `(name, how to reach it, tool profile)` — web, api, mobile, mcp, cli. The kind is resolved per
  project; only the cap is fixed. Don't hardcode frontend/backend: a "mobile" surface in practice
  tests the API the app consumes (you can't realistically drive a simulator), and a CLI surface
  tests a binary.
- **Why a sub-agent and not the main agent — independence of judgment, not parallelism.** The main
  agent wrote the code and holds a prior about what should work, which is the worst mindset for
  finding bugs: it will test the happy path it designed. **The QA agent gets the requirement and
  the URL, deliberately NOT the diff.** That is also what makes it a distinct worker kind rather
  than a prompt on an existing one.

### Tools

- **A scoped `http_request`, not the terminal.** `curl` hands over the whole shell to solve an HTTP
  problem — with it comes `rm`, `git checkout`, restarting the DB, reading `.env` into a prompt —
  and a QA agent is the likeliest to wander, because its job is literally "try things".
  - A native tool returns `{status, headers, body, ms}`, which _is_ the evidence the findings
    contract needs. Parsing `curl` output is where hallucinated findings come from.
  - It can be bound to the surface's declared origin. A shell cannot; a prompt asking it to stay on
    localhost is a suggestion, not a boundary (cf. the `cd` lesson — any absolute path shown to a
    model is somewhere it may go).
  - It generalizes: api, mobile and mcp surfaces are all the same tool.
- **Log READ, not command access.** A 500 with an empty body means the trace is in the dev server's
  stdout — already captured, because the main agent started it as a background command. Give the QA
  agent read access to that stream.
- **Terminal is a per-surface grant** the main agent declares, for CLI surfaces only, in the
  read-only sandbox profile. Running the project's own e2e suite stays the main agent's job — the
  suite is regression, QA is exploratory.

### Findings contract

- **Individual findings, one shared contract.** Shared notes conflict on write and contaminate —
  one agent reads another's speculation ("login seems broken") and hunts a bug that doesn't exist.
  Independence is the point of having two testers. What crosses between them is _observations at
  the boundary_ — the actual request/response — never opinions.
- **No evidence, no finding.** An agent that finds nothing feels like it failed, so it will invent
  something. This single risk decides whether the feature is loved or switched off.
  - Every finding carries a screenshot / status code / console line / log excerpt.
  - "Exercised X, Y, Z — all worked" is an explicitly blessed successful outcome.
  - "This is broken" is separate from "this is untested" — different confidence, different action.
  - Findings come back as claims the main agent **reproduces**, exactly like implementer proposals.
- **Record shape:** what I did → what I expected → what happened → evidence → does it reproduce.

### The plan is a floor, not a ceiling

A coverage contract (these must be exercised and reported) plus explicit licence to exceed it.
Enumerating the task alone would make it a slower, costlier test runner — and the checklist would
be written by the agent whose prior disqualified it from testing in the first place.

The report has two parts: per-item results (mechanical, complete, auditable) and unprompted
findings (exploratory).

**Structure lives in the spawn payload and the return schema — never as a tool the sub-agent
calls.** That is the TodoWrite pattern Anthropic retired on newer models as scaffold overhead, and
it would fail our own net-less-surface filter. The agent receives a list and returns a result keyed
to it; it never checks anything off.

> **The generalized rule: structure the return, not the work.** Every worker type returns a schema.
> Only workers whose value is _coverage_ (QA, implementer) receive an enumerated task; workers
> whose value is _discovery_ (explorer, architect) receive an objective.

**Settled 2026-08-17 — how an item gets marked done.** The alternative on the table was a
check-off tool the worker calls as it goes. Rejected, and the reason is enforcement rather than
surface area: a check-off is **self-report**, so a model that forgets the call looks like it skipped
an item it did, and a model that calls it eagerly marks done what it never touched — and _neither
mistake is detectable by us_. The return schema is checkable, because the harness still holds the
contract it sent: the worker must come back with one entry per item
(`{item, status: pass | fail | blocked | not-reached, evidence}`), and a missing item is a
validation failure that re-prompts naming exactly what is unaccounted for, not silence the user has
to notice. `not-reached` is first-class — it is the same "broken vs untested" distinction the
findings contract already insists on.

The counter, recorded honestly: Anthropic retired TodoWrite because _frontier_ models don't need the
scaffold, and we deliberately target weak and local models that genuinely do drift on a six-item
list. But a drifting model is precisely the one whose self-reported check-offs cannot be trusted.
**Build the contract and the validated return, measure on `tests/agent-evals` against a weak model,
and only if items are being dropped add a per-step `<system-reminder>` restating the contract with
current per-item status** — a few hundred tokens, needing no cooperation from the model, and no new
tool.

**What this costs:** live progress. A check-off tool could show "3 of 6" mid-run; a validated return
accounts for everything at the end. If live progress is wanted, derive it from the activity stream
that already feeds the per-worker cards rather than from a new tool.

### Reuse

Build on **`browser_test`** (`src/lib/tools/browser.ts`), which already runs a step sequence and
reports `passed` plus console errors and 4xx/5xx. QA is the exploratory loop _around_ it, not a
replacement. The in-app browser tools (`browser_navigate` / `browser_inspect` / `browser_interact`,
with stable element `ref`s), background commands with auto-promote, and per-mode tool profiles
(`resolve-toolset.ts`, `mode-tool-registry.ts`) all already exist — this is a new **role** in
existing machinery, not a new subsystem.

### Boundaries

- **Egress consent.** Loopback and private ranges are the default. Any non-local origin needs an
  explicit per-origin grant, shaped like the outside-workspace write grant: asked once, scoped to
  the workspace, recorded. Testing a URL you don't own **is attacking it** — indistinguishable from
  an attacker, from the user's IP, with Atlarix's name on it.
- **This is the first feature where the agent's actions leave the machine and land on someone
  else's infrastructure.** Our whole containment story is write-confinement, which says nothing
  about egress. It turns the gap noted in the `h5i` entry from theoretical into load-bearing.
- **A browser agent told "test the app" can click Delete Account**, and someone's `.env` will point
  at staging. Destructive interactions go through the existing approval path.

### Non-goals

- **Load / stress testing.** Recorded with the reasoning so it isn't re-litigated. Without a
  baseline, a controlled environment and warm-up, numbers off a dev machine hitting a debug build
  through a dev server are noise people will make decisions on. If a user explicitly asks, the
  honest deliverable is a k6/vegeta script they run from somewhere that isn't their laptop.
  _Functional testing asks a question; load testing applies force — consent for the first is not
  consent for the second,_ and volume is a separate, higher gate with a declared, capped rate.
- **Environment bring-up.** v1 requires the app already running with URLs named. Auto-detecting dev
  servers, seeding DBs and handling auth would eat the whole feature and yield a demo that works on
  Vite hello-world and dies on every real repo. Reading `Local: http://localhost:5173` out of a
  background command's stdout is the honest 80%.

### Direction past v1

A finding comes back **with a failing test that reproduces it**, feeding the verified-edits loop
rather than being a report read once. That also answers the "no test measures whether our own suite
is sensitive" note in TODO from the dynamic side: a QA agent doesn't trust the suite, it exercises
the app.

---

## Errors tab → Console + Network

_Recorded 2026-08-15 after an audit. **Both halves shipped in v14.31.0** (2026-08-16). What is kept
below is the record of what the audit found, the spike that overturned the CDP decision, and the
reasoning that outlived the implementation._

### What actually landed, and the one thing that changed the design

The plan was "upgrade the Errors tab". Testing the shipped Console tab against YouTube changed it
into something else: Google's logged-out `passive=true` probe returned 401, the completion gate read
that as "the app you built is broken", and the agent burned turns explaining to a gate that could
not hear it. **So the gate went, entirely.** The harness cannot tell whose error it is — a frontend
on `:5173` calling its own API on `:8080` is one app across two origins, a staging URL is the app
under test, an embedded Stripe script is third-party until it is yours — and every rule we could
write is wrong in one direction. A wrong block costs accuracy, which is the thing this whole app is
for.

What replaced it, in both directions:

- **To the model:** one `systemReminder` pointer per turn naming counts and the read tool. Never a
  dump — a chatty page costs one line, and the cost of watching a noisy tab is constant. What
  triggers it is `browserRuntimeNotice` in settings, defaulting broad, because no severity policy in
  the harness can be right for everyone.
- **To the user:** unread badges and "Send to Atlarix" on a row, a tab, or everything shown. This is
  the half that actually replaces the gate: when something genuinely IS broken, the person looking
  at it knows, and the harness does not have to guess.

The reasoning worth keeping: _a guard that cannot be right should inform, not block._ That is the
same conclusion `atlarix-loop-termination-no-caps` and the v14.8.10 "guards guide via the result
channel, never dead-end" note reached from different directions.

### CDP viability spike — RUN 2026-08-16, Electron 38.2.2

Attaching `webContents.debugger` + `Network.enable` to a **browser tab** (never the app window) is
**viable**. Measured with a cold cache on both sides — separate session partitions, because a shared
session makes the second load hit a warm HTTP cache and the comparison meaningless (the first
attempt showed a bogus −76.5% request drop that was entirely cache):

|                    | plain  | CDP attached |
| ------------------ | ------ | ------------ |
| requests completed | 29     | **39**       |
| load time          | 5337ms | **2467ms**   |

Attached saw _more_ requests and loaded _faster_, so **no sign of
[#23035](https://github.com/electron/electron/issues/23035)** ("attach blocks some requests") on
this version. It survived navigation (`requestWillBeSent` 51 → 172), stayed attached with no
`detach` event, and closed cleanly. Memory delta was smaller than the plain load's.

**Two findings that change the plan:**

1. **`Network.enable` hangs forever on a tab that has never navigated.** `attach()` succeeds, then
   the command simply never resolves — no error, no timeout. The target has no renderer to service
   it. Fix: prime with `about:blank` (or attach after the first load) before enabling. Any
   implementation MUST wrap `sendCommand` in a timeout — a silent hang here would look exactly like
   the session-restore bug fixed the same day.
2. **On-demand body retrieval is unreliable on a heavy page: 4/25 and 9/25 across two runs**, failing
   with `No resource with given identifier found` — the buffer had already evicted them. The
   approved choice was "on demand, per row", and on YouTube that means most bodies are gone before
   anyone asks. YouTube is a worst case (huge, streaming, constant churn) and a typical localhost dev
   app with a handful of XHRs would fare far better — but the UI must be honest that a body can be
   unavailable, and if bodies turn out to matter in practice the fix is fetching at
   `loadingFinished` for `xhr`/`fetch` only, which was the option declined at planning time. **Worth
   revisiting with real numbers rather than re-arguing.**

Also observed: CDP reported **more** requests than `webRequest` for the same load (47 finished vs 39
completed), so the two are not interchangeable inventories — CDP sees things webRequest does not.

**Still open — the Network tab.** `webRequest.onCompleted` still early-returns on `status < 400`,
so successful requests are never recorded and there is nothing to render. The design decision it
carries: `webRequest` exposes method, status, resourceType and headers, but **no transfer size and
no timing breakdown**. Duration has to come from our own `onBeforeRequest`→`onCompleted`
timestamps (request lifetime, not Chrome's phase breakdown) and size from `content-length` when the
server sends it. Devtools-grade numbers would require CDP — which takes `webContents.debugger`
exclusively and would reintroduce the exact conflict the Console work just removed. Recommendation:
stay on `webRequest` and be honest in the UI about what the numbers mean.

**Direction: two real devtools-style tabs; the Errors tab folds in and severity becomes a filter.**
Dev-server/build errors become a labelled _source_ inside Console, not a casualty. The completion
gate keeps reading only errors underneath.

```
Right panel
├─ Browser
├─ Console   [All ▾] [Errors] [Warnings] [Logs]
│    ▸ dev-server  ✗ TS2345 src/auth.ts:12
│    ▸ page        ⚠ React key warning
│    ▸ page        ℹ mounted
├─ Network   [All ▾] [XHR] [Doc] [Failed]
│    POST /api/items   500   142ms   1.2kB
│    GET  /api/me      200    31ms   840B
└─ Terminal
```

### What the audit found — the tab is thinner than it looks

- `src/ipc/utils/browser_view_manager.ts` — the `webRequest.onCompleted` hook opens with
  `if (status < 400) return;`. **Successful requests are never recorded at all**, so there is no
  data to build a Network tab from yet. It needs every request with method, status, resource type,
  timing and size.
- `src/lib/browser/error-hook.ts` — the injected hook only catches `window.error` and
  `unhandledrejection`. Plain `console.log` / `info` / `warn` never arrive. A Console tab needs a
  real console-message channel, not the `[[ATLARIX_ERR]]` sentinel alone.
- One buffer (`surfaceErrors`, capped at 50) holds both streams. Console and Network need separate
  ring buffers with their own caps — a chatty page currently evicts the network failures.
- **Three streams, not two.** Dev-server/build errors arrive via `src/lib/devServerErrorParser.ts`
  and `DevServerProvider.tsx`. They must survive the redesign as a labelled source.

### The risk that defines this change

**The completion gate must not widen with the panel.** `error-hook.ts` documents why: the gate
filters to `level: "error"` because React/Next dev mode emits benign warnings that must not block a
turn, and `NOISY_PREVIEW_RESOURCE_TYPES` is excluded so a missing favicon can't trip it.

Widening _capture_ for the UI while leaving the _gate_ predicate untouched is the whole job — and
`browser_test` reads the same buffer, so a mistake here silently changes when the agent believes it
is finished.

### Agent side — DONE

`browser_inspect(mode:"console"|"network")` were failure-only lenses. Both now show everything with
an explicit failures filter (`include:"failures"|"all"`), plus `tab_id` on both and `request_id` for
one row's headers and bodies. The point was never completeness for its own sake: an agent that can
only see failures can never **confirm a success**, which is also why a QA sub-agent could not have
used the old Errors tab as its observation channel.

---

## Fork sub-agents — CLOSED, the economics do not work

_Recorded 2026-08-15, **rejected 2026-08-17** after doing the arithmetic. Kept as a record so the
idea is not re-derived; the original sketch is preserved below the verdict because the mechanics
were sound even though the premise was not._

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

### The original sketch (retained for reference only — not scheduled)

`src/lib/agents/run-subagent.ts` builds `msgs` as a single `{ role: "user", content: prompt }`.
Workers start cold: they re-derive context the main agent already has, and every worker is a fresh
cache write rather than a read. On Core — a prepaid wallet metered at +80% — that is real money per
delegated turn.

### Why it is bigger than the release note suggests

For Anthropic the request is `tools → system → messages`, so the cached prefix covers all three. A
fork with a **different toolset or system header than its parent invalidates the cache entirely**
and the feature buys nothing.

So a real fork must share the parent's tool definitions _and_ system header. It is "another
instance of me with a sub-task" — **a distinct worker kind, not a flag on
explorer/architect/implementer.**

### Which resolves the read-only question

**A fork is constrained by policy, not by toolset.** Keep the parent's tool _definitions_ (prefix
intact) and refuse write execution at the existing funnel — `ToolRegistry.execute`
(`src/lib/tools/registry.ts`) and `src/ipc/handlers/permissions/interceptor.ts`. The same shape as
the committable `.atlarix/permissions.json` deny rules, reused rather than reinvented.

### Sketch

1. **Expose the parent's history.** The turn's `msgs` is a local in the stream handler;
   `StreamTurnContext` does not hold it. A `forkableTurnStateByChatId` map in
   `src/ipc/handlers/chat_stream/stream-state.ts` follows the `Map<number, X>` pattern already used
   there (`partialResponses`, `streamTurnIdByChatId`), carrying history + system header + tool
   definitions. Keeps the satellite rule intact — no satellite imports the parent handler.
2. `RunSubagentArgs` gains an optional inherited context; `msgs` becomes
   `[...history, { role: "user", content: prompt }]`.
   `buildStreamMessagesWithCacheBreakpoints` already takes `systemHeader` + `history`, so no new
   cache machinery is needed.
3. `subagent_type: "fork"` in `spawn-task.ts` / `builtin-agents.ts`, through the existing
   `runSubagent` call.
4. **Guard the size.** A fork inherits the whole conversation, so a long thread makes an expensive
   worker. Gate on remaining context budget and fall back to a cold scout with a logged reason
   rather than failing.
5. **Tool-description guidance** on `task`: fork for a sub-task that depends on what just happened;
   explorer for independent recon where a cold, cheap context is the point. Getting this wrong
   makes every delegation expensive.

### Verification when it lands

The honest check is a real dispatch, not a unit test: run a turn with an Anthropic key, spawn a
fork, and read the `[prompt-cache]` log line already emitted in `simple-stream-text.ts` — a fork
should show a large `read=` where a cold scout shows `write=`. Then an `agent-evals` scenario
asserting a fork sees prior-turn context a cold scout cannot.

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
scrub them.** That is also consistent with the deliberate decision at `lib/tools/glob.ts:221` that
in-workspace files including `.env` are enumerable.

Unaffected and still in place: **display- and telemetry-side** redaction — Sentry `beforeSend`, and
`redactGitUrlCredentials` on git stderr — which scrub values we _do_ own on paths that leave the
user's control.

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
`app.configureWebAuthn({ touchID })` does not do that, and cannot.

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
used. **That chooser is the feature. Do not remove it as passkey dead code.**

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
- **Complexity is concentrated, not spread**: `interceptor.ts` is still 2,127 lines, ~40% of the
  surface in one file. If anything here is overcomplicated it is that file's internal structure,
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

Noted, not scheduled. Sources: opencode `v1.18.17`, claude-code `v2.1.229` / `232` / `233`.

- **Native PDF document parts.** PDFs are locally text-extracted today
  (`lib/tools/workspace.ts`), so scanned/image-only PDFs fail outright — the tool says so — and
  table/layout fidelity is lost even on good ones. Anthropic, Gemini and OpenAI all accept native
  PDF parts with vision, and we already send images as native parts
  (`chat_stream/message-postprocess.ts`). Gate on model capability, keep extraction as the
  fallback. opencode shipped this for Copilot models.
- **`run_command` memory/CPU containment.** Claude Code added a Linux memory cgroup so a runaway
  build can't stall the session. The stronger version for us is **Windows Job Objects**, which also
  fixes orphaned grandchildren on cancel — a classic Electron bug worth checking regardless.
- **First-class `llama-server` detection** beside Ollama and LM Studio. It is already reachable as
  a custom OpenAI-compatible endpoint, just undiscoverable. The real payoff isn't the connection —
  it's that `/props` reports the true `n_ctx` and chat template, retiring the guesswork in
  `resolve-model-context-limit.ts` / `context-window-heuristics.ts`. Wrong context limits on local
  models are a silent correctness bug.
  - **Embedded inference via `node-llama-cpp` is NOT recommended.** We have the precedent (Whisper,
    ONNX, worker thread, WebGPU/WASM fallback) and know what it cost: three diagnoses before the
    device×dtype matrix settled it. Inference multiplies that — native module per platform × ABI on
    top of better-sqlite3/node-pty/keytar, Metal/CUDA/Vulkan backends, a 4–8GB download — for a
    model still weak at agentic tool-calling. Ollama already solves this for whoever wants it.
- **Per-model sampling defaults.** opencode fixed DeepSeek V4 Flash specifically; GLM tool-calling is
  genuinely temperature-sensitive, so this is a quality lever on the Core path. Re-check it against
  the GPT 5.6 tiers, which replaced DeepSeek on core-2/3 and reject `temperature` outright.
- **Route chore calls to the cheapest available model** — session titles, compaction summaries, the
  streaming compass one-liner, commit messages. They don't need the top tier — and the saving grew
  when core-2/3 became GPT 5.6 at $2.00/$12.00 and $4.00/$20.00 per M. Same saving as embedded
  inference with no new
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
- **Approval notifications.** Upstream fixed Notification hooks not firing for permission prompts.
  An OS notification when the window is backgrounded and a turn is waiting for approval is small
  and immediately felt, especially alongside automations.
- **Session-scoped web fetch cache.** Upstream made its 15-minute URL cache TTL configurable, which
  implies the cache. If the agent fetches the same URL three times in a research turn, that is
  tokens and latency paid twice.
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

## Mobile: refs, not coordinates — 2026-09-02

`mobile_inspect` + `mobile` mirror the browser pair on purpose, down to the naming, so a
model that knows one knows the other. Three decisions are worth keeping.

**Refs, not coordinates.** `adb shell input tap X Y` is the obvious primitive and the wrong
contract. A coordinate is correct for one screen size and density; on any other it taps empty
space — and it does so by SUCCEEDING. `input tap` returns 0, nothing happens, and the agent
reads an unchanged screen and concludes the app is broken. `uiautomator dump` gives `bounds`,
`resource-id`, `text`, `content-desc` and `clickable` per node, which is the exact analogue of
a browser element ref, and a stale ref fails loudly. Refs are re-resolved against the LIVE
screen on every act, never cached from the last read: a cached index still resolves after a
screen change, to a different element, which is the bug refs exist to prevent.

**Text first, screenshot last — and the DEFAULT is the cheap one.** The same argument
`browser_inspect` makes: a hierarchy dump answers "what is on screen", "is the button there",
"did the form submit" in a few hundred tokens, and a PNG answers fewer questions for thousands.
Both mobile tools are peripheral under `tool-reveal`, so a Build turn binds their first
sentence and a `tool_help` pointer — which is why the first sentence carries the cheap default
rather than an introduction, and why neither needed a `NEVER_TRIM` entry. That list is
reserved for prose preventing an observed failure; making the default correct is strictly
better than exempting a tool from a mechanism that exists to save tokens.

**Report a platform gap as a LIMITATION, not a failure.** `simctl` screenshots, streams logs
and launches an app; it has no hierarchy dump and no input injection (those need `idb`, a
separate install with its own daemon). An agent told "not supported, do not retry" stops; an
agent told "failed" retries, and retrying a capability the platform does not have is an
expensive way to learn nothing. The wording is asserted by a test, because it is the
behaviour, not decoration.

**Every mode, not build/debug only.** The first cut was build/debug, on "you do not tap
through a simulator from Explore". That was wrong, and the argument that corrects it is the one
already written for `browser`: neither tool touches the WORKSPACE — driving an emulator changes
a device's state, not the project — so Plan's filesystem-read-only rule is untouched, and "what
does this look like on a phone" is a question, which is Explore's whole job. The cost is ~471
tokens on each read-only mode, and it is affordable only because both tools are peripheral
under `tool-reveal` in every mode: one sentence plus a `tool_help` pointer.

Of that 471, descriptions are 140 and parameter SCHEMAS are 318. The 140 is already
post-reveal, so reveal is doing its job; the schemas are the residue, because reveal trims
parameter PROSE and deliberately keeps every parameter, type, enum and default. That is where
to look next, not at the descriptions.

**But NOT where there is nothing to look at.** Dropped headless (the Electron-free npm CLI and
the Harbor agent that wraps it) and dropped unattended (an automation nobody is watching) — the
same `DRIVES_A_VIEW` predicate as the browser. So making them every-MODE did not put them in
the headless surface, and no change to the npm package or the Harbor integration is needed.
`adb` may well exist on a benchmark machine; an emulator does not.

**`execFile` does not protect the FAR shell.** `runDeviceCli` passes an argv array, so there is
no local shell to inject into — but `adb shell <args…>` joins its remaining arguments and runs
the result through `/system/bin/sh -c` ON THE DEVICE. So `input text "a; rm -rf /sdcard/x"`
runs the `rm`. The fix is to quote for the device shell (`quoteForDeviceShell`, POSIX
`'\''`) and to VALIDATE the package id rather than quote it, since anything outside
`[A-Za-z0-9._-]` is a model mistake worth reporting.

This is not an escalation of what the agent may do — it can already call `adb` through
`run_command`. It matters because the typed string is not always the agent's own words: an
agent types what it READ, from a page or a file, which makes this the path by which
prompt-injected content would reach a device shell. Quoting also removed the need for adb's
`%s` space substitution, and is better than it: `%s` mangles a literal percent in the text.

**Watching it work: use the platform's own indicator.** `ai-cursor.ts` draws a pointer, a
target ring and an action chip into the PAGE, which is possible only because we inject JS into
something we control. An emulator is a separate OS-level window we can only send input events
to. Android already solves this with the `show_touches` developer setting, so the equivalent of
the AI cursor is one `settings put` — and it applies to taps we send exactly as to the user's
own.

That writes a setting on someone's device, so the restraint is the design:

- once per device per process, and on an **ACT only** — looking at a screen must never change it;
- the previous value is read BEFORE writing, and restored in the `before-quit` chain (an unset
  key is `delete`d, not written back as the literal string `"null"` that `settings get` prints);
- a device that already had it on is recorded as such and left completely alone on restore;
- entirely best-effort and silent on failure, because a visual nicety must never be the reason
  a tap fails — and it must not CLAIM to have worked when the write failed, or restore would
  later "undo" a change that never happened.

The lifecycle routes through `setDeviceCliRunnerForTests`, an explicit seam: `vi.mock` cannot
intercept it, because `ensureTapFeedback` calls `runDeviceCli` from inside the same module and
the call is a lexical binding that never goes through the module's exports.

**No npm or Harbor change was needed for any of this,** which was worth checking rather than
assuming: the headless surface is COMPUTED by `resolveToolsetForSession`, never declared, and
`headless-runner.ts` sets `ATLARIX_HEADLESS=1` before any turn resolves a toolset. Nothing in
`src/headless/` or the docs enumerates a tool list, so making the mobile tools every-MODE did
not put them in the CLI's surface.

**These calls do NOT go through the command sandbox, and that is worth saying out loud.**
`run_command` is enforced by the OS sandbox (Seatbelt / AppContainer / Landlock); the mobile
tools `execFile` `adb` directly from the main process, exactly as the browser tools call
Electron APIs directly. So Plan and Explore running a read-only sandbox profile does not
constrain them — which is consistent with the reasoning above (a device is not the workspace)
but must not be mistaken for "the sandbox covers this".

What DOES cover them is the permission ruleset at `runToolExecute`, which is tool-name based,
so `{"deny": ["mobile"]}` in `.atlarix/permissions.json` works and is the supported way to
switch this off per project. The reach is also not new: `adb` was already available through
`run_command`, so the sandbox never constrained driving a device — the wrapper adds refs, not
reach.

**The asymmetry was the vulnerability.** The release security review found one real issue, and
its shape is the lesson: three call sites took an app identifier from the model, and each
treated it differently — `action:"launch"` VALIDATED it with `isValidPackageId`, the Android
`logs` path QUOTED it for the device shell, and the iOS `logs` path did NEITHER, interpolating
it into an NSPredicate (`process CONTAINS "…"`). `.split(".").pop()` was standing in for a
sanitiser there, and it is not one: a payload containing no dot passes through whole, quotes
included, so `x" OR message CONTAINS "password` widened a filter the tool then still described
as scoped to one app.

Not shell injection — `execFile` takes an argv array — but NSPredicate is an expression
language, and this was the single place a model-relayed string reached an interpreter
unescaped. The impact was bounded (omitting `package` with `level:"all"` already returns an
unfiltered log), so the real damage was attribution: a cross-process selection presented as one
app's log. Fixed by validating once, up front, for both platforms.

**Worth generalising:** when the same untrusted value reaches N call sites, the risk is not the
weakest treatment, it is the DIFFERENCE between them — because a reviewer checking one site
concludes the value is handled. Validate at one boundary, before the branch.

**Scope discipline.** No device manager, no install pipeline, no log streaming beyond a
bounded tail. Booting emulators, installing APKs and tailing logs all work through
`run_command` today; wrapping them would be surface without capability — the thing this
release spent its budget removing. The wrapper earns its tokens only where it adds what
`run_command` cannot: refs.

**What a live device found that 30 mocked assertions could not.** The iOS half was run against
a booted iPhone 17 simulator, and the mocked suite had been green through all of this:

- `simctl io <id> screenshot -` looks like the `adb exec-out screencap -p` equivalent and is
  not: `simctl` treats `-` as a FILENAME. Exit 0, zero bytes on stdout, and a junk file called
  `-` in the working directory.
- `--predicate 'messageType >= "Default"'` matched NOTHING — 0 characters against 18.7 MB
  unfiltered. A silent zero, so every iOS log read reported "No recent entries" whatever had
  happened. Apple's unified log has no "warn" level and the comparison operator does not apply
  to that field.
- A simulator log is the whole OS: 3.2 MB over two minutes filtered to errors, versus 184
  characters with a process filter. That gap is why `package` exists on the read.
- A real screenshot is 2.85 MB, i.e. ~3.8 MB of base64.

Every one of those is a thing that "works" in a mock, because a mock returns what you told it
to. **The general lesson is not "write more tests" — it is that a wrapper around an external
CLI has to be run against that CLI at least once**, and the assertion that catches these is
about the SHAPE of the real output (PNG magic bytes, a non-zero character count), not about
the arguments we passed.

The suite keeps `mobile-live-ios.test.ts` and `describe.skipIf`s it when nothing is booted, so
it costs nothing on a machine without Xcode and is there the moment someone boots a device.

**The ANDROID half was then verified — 2026-09-04 — and the very first command was broken.**
`adb shell uiautomator dump /dev/tty` exits **0** and returns exactly `UI hierchary dumped to:
/dev/tty` (32 characters, upstream's typo included) with **no XML at all**: `adb shell` allocates
a pty, and the document written to /dev/tty never reaches adb's stdout stream. So the entire
Android read path — the read AND the per-act ref resolution, which share `readHierarchy` —
returned nothing, silently, from the moment it shipped. `exec-out` takes the raw binary path and
returns the document (12,338 characters on the launcher screen).

That is the **same failure as `simctl io <id> screenshot -`**, one section above, on the other
platform, from the same cause. Twice in one tool is enough to state the rule rather than the
anecdote: **a wrapper around an external CLI is UNVERIFIED until it has been run against that
CLI, and the assertion that catches this class is about the SHAPE of the real output — a document
containing nodes, PNG magic bytes, a non-zero character count — never about the arguments we
passed.** A mock returns what it was told to, so a green mocked suite is not evidence either time.

`mobile-live-android.test.ts` mirrors the iOS file, `describe.skipIf(!hasBootedDevice())` and
resolving `adb` through the shipped locator, so a machine whose SDK the app cannot find reports
"nothing to test" rather than failing every assertion.

**And a second bug was found only because the checklist was FINISHED rather than abandoned at the
first green loop.** `action:"launch"` used `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`
— the recipe everyone copies. On API 35 monkey exits **251**, writes its argument dump to
**stderr**, and the activity never comes to the foreground. It now resolves the component with
`cmd package resolve-activity --brief` and starts it with `am start -n`, which exits 0 and
actually launches. The first run of this file stopped after hierarchy, tap and screenshot and
deleted the emulator with `type`, `swipe`, `launch` and the log reads still unexercised; the
launch bug was sitting in the part that had been skipped. **A verification checklist that already
exists is not advisory — stopping at the first green result is how the second bug survives the
run that was supposed to find it.**

**The mirror-image lesson, and it cost more time than either bug.** Two of the four failures in
that run were the TEST's fault, and both looked exactly like product defects:
`ToolRegistry.execute` nests a result under `result` but TRUNCATES a large payload into a JSON
_string_ (with `_truncatedOutput`/`_originalSize`), so `.content` read off it is `undefined` —
which is why `mode:"logs"` appeared to return nothing while it was returning 400 lines; and
`runDeviceCli` returns both `stdout` and `buffer`, so reading a PNG from the string corrupts byte
0 and the magic-byte assertion fails on a good image. A live test manufactures false accusations
as readily as a mock manufactures false confidence. **Reproduce the failure against the raw CLI
before believing the wrapper is at fault** — that is what separated the two real bugs from the two
imaginary ones.

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

**Superseded on ordering 2026-09-12 — the EXTENSION goes first.** Everything below
stands as the CLI brief; only its position in the queue changed. The CLI remains the
cheaper build (~80% done, name held on npm), so none of this expires.

**What already exists.** `atlarix` is published on npm (v14.45.0, PROPRIETARY,
`packages/headless`), driving the REAL agent loop through a 140-line Electron stub —
`src/headless/` is 1,130 lines of driver, not an implementation.
`src/headless/atlarix-headless.mts:5` already reserved room for an interactive mode and
shaped the arg parsing so the published binary never has to change. **So this is a TUI,
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
required_cents:N}`, plus `403 account_banned`, `400 model_not_permitted`,
`503 core_unavailable`. The CLI renders "you are $X short → atlarix.dev/account" straight
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
at `src/db/index.ts:105` returns a value, not a promise, and session persistence, provider
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
ENGINE (the ~18.5k-line loop and ~16.8k lines of tools it drives — the Electron shell is the
least valuable part), and you can open-source later but never un-open-source. Recommended
sequence unchanged: **ship the TUI free and closed, measure, then decide once, with data.**

---

## 🧭 Three products, one engine — the boundary that decides scope (2026-09-11)

Atlarix now has three shipping surfaces over one agent loop. Without a stated boundary they
converge, because every one of them will at some point have a good reason to grow the
others' capabilities. **The boundary is what each may TOUCH**, and it is a capability rule
rather than a positioning one, so it answers scope questions on its own:

|                 | **CLI**                                    | **Extension**                                   | **Desktop app**                            |
| --------------- | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------ |
| Touches         | your files and your shell                  | your **browser session**                        | both, plus its own unauthenticated browser |
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
  `credit_transactions` are keyed on `user_id`, and the README already states the rule for
  the two surfaces that exist today: _"One subscription, one balance… they are not billed
  separately and they do not hold separate balances."_ Adding the CLI and the extension
  means they present the user's Supabase JWT exactly as the desktop does, and the same
  `record_compass_usage` path runs. **No wallet change, no new endpoint, no new RPC.**
- **The one real gap is ATTRIBUTION, and half of it is already built.**
  `credit_transactions` carries `kind` and a free-text `ref`, and the service debit RPC
  already takes `p_source text DEFAULT 'reviewer'` — which is how the account page itemises
  reviewer spend separately today. The user-JWT path has no equivalent label, so desktop,
  CLI and extension spend would collapse into one undifferentiated line.
  **Work needed:** an `X-Atlarix-Surface` header on the client (modelled on the existing
  `x-atlarix-repo`, which `server.ts:488` notes is "only a label on the ledger row — it
  never selects an account"), threaded into `p_source` on the user path, and four rows on
  the account page instead of two.
- **Do the label BEFORE the surfaces ship, not after.** A ledger row cannot be
  re-attributed later: spend recorded without a source is indistinguishable forever, so
  the first month of CLI and extension usage would be permanently unsplittable from the
  app's. This is cheap now and impossible retroactively.
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
`chat_stream_handlers.ts:447` calls `requireAuthSession()` before every turn, so the desktop
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

## 💵 Pricing — SETTLED 2026-08-26, and the code that implements it

> Owner decisions, recorded so they are not re-argued. The reframe's rule survives intact: **never
> ship a tier whose fee is fully consumed by bundled inference.** What changed is that the fee now
> includes _some_ inference, because the old shape asked for two purchases before a new user's first
> agent turn — and that is where the funnel was dying. 108 users at the time of this decision.

- **Atlarix Pro stays $19/mo** and includes a monthly Core allowance, PAYG on top. Price
  deliberately NOT raised: $19 sits under Cursor/Windsurf $20 on purpose, and raising it while
  improving it makes the win ambiguous. **If more revenue is wanted, the lever is the allowance
  size, not the sticker** — the sticker is what people compare.
- **THE ALLOWANCE IS $19, NOT $10 — this section said $10 until 2026-09-10 and was wrong.**
  `MONTHLY_GRANT_CENTS.pro = 1900` (`handle-lemon-webhook/index.ts`). It was raised on
  2026-09-08 when Atlarix Reviewer folded into Pro — one subscription, one allowance, because
  the alternative asked a customer who had already paid $19 to pay $19 again. The arithmetic
  below was not updated with it, so this file claimed ~59% margin while the webhook's own
  comment said ~23%. **The webhook is the source of truth; the number here is a copy.**
- **`MARKUP = 1.8` since 2026-09-10, and a mark-up is not a margin.** It multiplies COST:
  $1.80 of credit per $1.00 of inference is `0.80/1.80 = 44.4%` gross on the credit spent, and
  LemonSqueezy's ~7.5% of money-in leaves `1 - (1/1.8)/(1-0.075) = ~40%` net at FULL
  consumption. In dollars: $19 nets ~$17.57, buys ~$10.56 of inference, profit ~$7.01.
  **It was 1.4, which netted only ~22.8%** — the number this file spent months describing as
  "40%". Identical on PAYG, because both hand over $X of credit for $X paid, so the mark-up and
  not the price is what sets the margin on both.
- **The ceiling on the mark-up is BYOK, which we give away and price-tag per reply.** The app
  shows the cost of every turn, so a user who can read that number and compare it to provider
  list price has a free escape hatch built into the same dropdown. Realised margin also sits
  above the full-consumption figure, because the allowance expires monthly and most
  subscribers underspend.
- **Do NOT publish the allowance figure.** Say "includes Core for everyday work". Denominating an allowance
- **REVIEWER IS INCLUDED IN PRO. There is ONE product.** This section said the opposite until
  2026-09-14 — "Atlarix Reviewer is $19/dev/mo" and "Pro and Reviewer are separate products,
  link them with a discount, not inclusion" — and both were withdrawn on 2026-09-08 when
  Reviewer folded into Pro, because the alternative asked a customer who had already paid $19
  to pay $19 again. **The code is the proof, not this file:**
  `handle-lemon-webhook/index.ts` declares `MONTHLY_GRANT_CENTS: Record<"pro", number>` — one
  product, no classification step — and `20260908130000_drop_reviewer_subscriptions.sql`
  dropped `reviewer_subscriptions`, `reviewer_entitlement_service` and
  `upsert_reviewer_subscription_service`. **Verified absent from the live database
  2026-09-14**, along with `credit_grants` holding exactly one product row: `pro`.
- **So there is one wallet, one allowance and one grant row per user.** `credit_grants` is
  still keyed `(user_id, product)` and `spend_from_wallet` still takes a preferred product —
  both are correct shapes to keep, and they are why a second product would need no schema
  change. But only `'pro'` is ever written today, so `debit_wallet_service`'s
  `CASE WHEN p_source = 'reviewer' THEN 'reviewer' ELSE 'pro' END` never takes its first
  branch: a reviewer debit finds no `'reviewer'` grant, falls through the "any other
  allowance" loop, and spends the Pro allowance. **Right outcome, reached by a path that
  reads as though two products exist.** Do not "fix" it — it is the correct shape if a second
  product ever returns — but do not read it as evidence that one does.
- **What is still true from the old reviewer pricing, and worth keeping:** no open-source
  exemption (that was an INTENT never built, withdrawn 2026-09-04, spec §8 Rev 4 — the
  reviewer has no repository-visibility logic, so a public repo hits the same gate and the
  same debit as a private one); unlimited repos, because **nobody charges per repo** and
  per-repo punishes microservice teams who have the most PRs and the most to gain; and it is
  safe to give away because a dev's PR output is bounded by being human (~10/month regardless
  of repo count). Seats become an upgrade when a team asks for one invoice — `github_installs`
  already ties an installation to exactly one account, so that needs no seat detection, no LS
  quantity API and no reconciliation job.

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
  repeated INSERTs safe, which assumes deltas add up. A replayed grant has to be refused _before_ any
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

