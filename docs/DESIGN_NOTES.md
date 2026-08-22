# Atlarix design notes

Work that has been **designed but not scheduled**. Each entry exists so the conversation resumes
cold instead of being re-derived. [`docs/TODO.md`](./TODO.md) carries a one-line pointer per entry;
this file carries the reasoning.

Nothing here is a commitment. An entry graduates to TODO when it becomes active work, and to
[`docs/CHANGELOG.md`](./CHANGELOG.md) when it ships.

**Last updated:** 2026-08-19

---

## The e2e suite — RETIRED 2026-08-19, and why not repaired

*Recorded so "we should bring back e2e" starts from the measurement rather than the instinct.*

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
concern as *Suite sensitivity* below, arrived at from the opposite direction.

**If a future suite is written:** wire it into CI on day one, before writing the second spec. Coverage
that is not executed on every push is a liability with a plausible face. `git log` has the old suite if
its scenarios are useful as a starting list.

---

## Account bans — SHIPPED 2026-08-19, recorded for the scope decision

*The reasoning is here rather than in the CHANGELOG because the interesting part is what a ban
deliberately does NOT do, and that will be re-litigated the first time someone asks why a banned user
can still use the app with their own key.*

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

*Recorded 2026-08-15. The agent's own QA pass: after building something, spawn workers that
exercise the running app and report findings.*

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
  - A native tool returns `{status, headers, body, ms}`, which *is* the evidence the findings
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
  Independence is the point of having two testers. What crosses between them is *observations at
  the boundary* — the actual request/response — never opinions.
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
> Only workers whose value is *coverage* (QA, implementer) receive an enumerated task; workers
> whose value is *discovery* (explorer, architect) receive an objective.

**Settled 2026-08-17 — how an item gets marked done.** The alternative on the table was a
check-off tool the worker calls as it goes. Rejected, and the reason is enforcement rather than
surface area: a check-off is **self-report**, so a model that forgets the call looks like it skipped
an item it did, and a model that calls it eagerly marks done what it never touched — and *neither
mistake is detectable by us*. The return schema is checkable, because the harness still holds the
contract it sent: the worker must come back with one entry per item
(`{item, status: pass | fail | blocked | not-reached, evidence}`), and a missing item is a
validation failure that re-prompts naming exactly what is unaccounted for, not silence the user has
to notice. `not-reached` is first-class — it is the same "broken vs untested" distinction the
findings contract already insists on.

The counter, recorded honestly: Anthropic retired TodoWrite because *frontier* models don't need the
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
reports `passed` plus console errors and 4xx/5xx. QA is the exploratory loop *around* it, not a
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
  *Functional testing asks a question; load testing applies force — consent for the first is not
  consent for the second,* and volume is a separate, higher gate with a declared, capped rate.
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

*Recorded 2026-08-15 after an audit. **Both halves shipped in v14.31.0** (2026-08-16). What is kept
below is the record of what the audit found, the spike that overturned the CDP decision, and the
reasoning that outlived the implementation.*

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

The reasoning worth keeping: *a guard that cannot be right should inform, not block.* That is the
same conclusion `atlarix-loop-termination-no-caps` and the v14.8.10 "guards guide via the result
channel, never dead-end" note reached from different directions.

### CDP viability spike — RUN 2026-08-16, Electron 38.2.2

Attaching `webContents.debugger` + `Network.enable` to a **browser tab** (never the app window) is
**viable**. Measured with a cold cache on both sides — separate session partitions, because a shared
session makes the second load hit a warm HTTP cache and the comparison meaningless (the first
attempt showed a bogus −76.5% request drop that was entirely cache):

| | plain | CDP attached |
| --- | --- | --- |
| requests completed | 29 | **39** |
| load time | 5337ms | **2467ms** |

Attached saw *more* requests and loaded *faster*, so **no sign of
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
Dev-server/build errors become a labelled *source* inside Console, not a casualty. The completion
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

Widening *capture* for the UI while leaving the *gate* predicate untouched is the whole job — and
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

*Recorded 2026-08-15, **rejected 2026-08-17** after doing the arithmetic. Kept as a record so the
idea is not re-derived; the original sketch is preserved below the verdict because the mechanics
were sound even though the premise was not.*

### Why it was dropped

**The saving was counted once and paid every step.** A cache read is ~0.1× base input, so the note's
framing — "a fork reads the prefix instead of writing one" — is true of the worker's *first* call
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

Workers *do* re-derive context the parent already has — that part was correctly observed. The fix is
the pattern this app already applies everywhere else: **pointers, not payloads.** The parent writes
the `prompt` today; what is missing is anything pushing it to hand over the `file:line` facts it has
already established. Pointers cost a few hundred tokens and let the worker read only what it needs —
the same reasoning that makes `.atlarix/skills` and project memory an index rather than a payload.
That is prompt and tool-description work, not a subsystem.

### The original sketch (retained for reference only — not scheduled)

`src/lib/agents/run-subagent.ts` builds `msgs` as a single `{ role: "user", content: prompt }`.
Workers start cold: they re-derive context the main agent already has, and every worker is a fresh
cache write rather than a read. On Core — a prepaid wallet metered at +40% — that is real money per
delegated turn.

### Why it is bigger than the release note suggests

For Anthropic the request is `tools → system → messages`, so the cached prefix covers all three. A
fork with a **different toolset or system header than its parent invalidates the cache entirely**
and the feature buys nothing.

So a real fork must share the parent's tool definitions *and* system header. It is "another
instance of me with a sub-task" — **a distinct worker kind, not a flag on
explorer/architect/implementer.**

### Which resolves the read-only question

**A fork is constrained by policy, not by toolset.** Keep the parent's tool *definitions* (prefix
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
dropped, the surviving and sharper distinction is about *input structure*, not inheritance:

> **Enumerated input for workers whose value is coverage (QA, implementer); an objective for
> workers whose value is discovery (explorer, architect). Structured output for every worker.**

Handing a discovery worker a checklist turns it into a batch reader that cannot tell you about the
item nobody thought to list.

---

## Model-context secret redaction — CLOSED, do not re-propose

*Reframed 2026-08-15, **rejected 2026-08-17**. Kept only so the argument is not made a third time.*

The reframe was: a repo scanner hunts secrets it has never seen and pays >50% false positives for
it, but **we hold the user's actual secret values**, so exact-string redaction of those is
zero-false-positive with no ruleset — with ~20 vendor prefixes (`ghp_`, `sk-ant-`, `AKIA`, …) as a
second tier.

**Why that was not enough.** The zero-FP claim only covers the secrets we happen to store. Every
other secret on the user's machine — the ones in their `.env`, their CI config, their shell history
— is caught only by tier 2, and tier 2 is a hardcoded list: wrong at the edges, needing maintenance
forever, and *presenting itself as a guarantee it cannot make*. A partial redactor is arguably worse
than none, because it changes what users believe is safe to hand the agent. The owner's original
position stands: **we trust the agent and the provider with credentials, and we do not pretend to
scrub them.** That is also consistent with the deliberate decision at `lib/tools/glob.ts:221` that
in-workspace files including `.env` are enumerable.

Unaffected and still in place: **display- and telemetry-side** redaction — Sentry `beforeSend`, and
`redactGitUrlCredentials` on git stderr — which scrub values we *do* own on paths that leave the
user's control.

---

## Suite sensitivity — is "tests pass" a claim about the change?

*Recorded earlier, moved here 2026-08-15.*

There is no mutation testing, and no eval scenario where the fixture repo's suite is deliberately
wrong or incomplete. So a green run is a claim about the **suite**, not about the change.

v14.30.0 produced two clean instances: unit tests that asserted the *wrong* dtype diagnosis and
passed, and 2,782 green tests plus a successful local package that still shipped a Windows-only
packaging break.

**Candidate approach:** eval fixtures whose suite is a trap — it passes while asserting the wrong
invariant; it reports 100% pass with zero coverage of the changed path; it makes a tautological
assertion. Score the agent on whether it *says* the suite doesn't cover the change, rather than on
whether the suite is green.

The QA sub-agent above is the dynamic counterpart to this: it doesn't trust the suite, it exercises
the app.

---

## `h5i` — evaluated, reference only

*`github.com/h5i-dev/h5i`, Apache-2.0. Evaluated and NOT adopted.*

A standalone Rust CLI that sandboxes AI coding agents in tiers (workspace / process / supervised /
container / microvm).

**Not adoptable:** it is a peer harness, not a library, and its leverage is Linux — its `process`
tier is Landlock + seccomp + namespaces, which we already ship natively, while Windows (Low IL) and
macOS (Seatbelt) get nothing from it. The container and microvm tiers would require users to install
Podman or have `/dev/kvm`.

**Worth borrowing:** the tier vocabulary, and its `supervised` tier — private netns + nftables
egress allowlist — which is a capability we lack and is genuinely distinct from write confinement.
Also its honest framing:

> *"It cannot stop an agent from putting your code in a prompt. Containment keeps the agent off your
> machine. Model egress is a separate control."*

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
it valid. It killed the signed v14.35.0 macOS build twice. See `docs/TODO.md`.

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
the *same* credential Brave would have used. Both go through Chromium on every platform and need no
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
  and deleting *modules* cannot touch it. Not a task — there is no observed failure — but it is
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
- **Per-model sampling defaults.** opencode fixed DeepSeek V4 Flash specifically; GLM and DeepSeek
  tool-calling is genuinely temperature-sensitive, so this is a quality lever on the Core path.
- **Route chore calls to the cheapest available model** — session titles, compaction summaries, the
  streaming compass one-liner, commit messages. They don't need Core 4. Same saving as embedded
  inference with no new dependency.
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
  Our re-entry path is the clone dialog: the agent clones a repo into the workspace, and that repo
  ships `.atlarix/hooks.json`, which is `/bin/sh -c`'d on every tool call. The original hole was
  closed with authority-file approval — the open question is whether a repo cloned *mid-session*
  re-triggers it.
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
