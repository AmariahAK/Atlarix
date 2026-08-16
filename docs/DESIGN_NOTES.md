# Atlarix design notes

Work that has been **designed but not scheduled**. Each entry exists so the conversation resumes
cold instead of being re-derived. [`docs/TODO.md`](./TODO.md) carries a one-line pointer per entry;
this file carries the reasoning.

Nothing here is a commitment. An entry graduates to TODO when it becomes active work, and to
[`docs/CHANGELOG.md`](./CHANGELOG.md) when it ships.

**Last updated:** 2026-08-15

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
> whose value is *discovery* (explorer, architect, fork) receive an objective.

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

*Recorded 2026-08-15 after an audit. **The Console half shipped the same day** — see TODO's
"In flight". What remains below is the Network half and the record of what the audit found.*

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

### Agent side

`browser_inspect(mode:"console"|"network")` are failure-only lenses today. They need the same
all-levels / all-requests view with an explicit failures filter, so the agent can **confirm a
success** rather than only observe a failure. That gap is also why a QA agent cannot use the
current Errors tab as its observation channel: it is a failure feed, and QA needs to report what
worked.

---

## Fork sub-agents

*Recorded 2026-08-15. Scoped for that session's batch, then pulled once the cache constraint became
clear.*

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

### The inversion worth keeping

Fork inherits **everything** for cost and context. The QA agent inherits **deliberately little**
for independence. Explorer inherits **an objective**. Three deliberate context postures, each with
a stated reason — that is what makes the worker taxonomy coherent rather than three ad hoc types.

---

## Model-context secret redaction

*Reframed 2026-08-15. Previously deferred behind sandbox read-confinement; it is independent of it.*

The old objection was that we can't cater for every secret shape on the planet, and the research
backs the instinct: generic entropy+regex scanners historically run **>50% false positives**
(gitleaks ships 150+ patterns and still needs per-rule entropy thresholds and allowlists).

But that is a repo scanner's problem — hunting secrets it has never seen. **Ours is inverted: we
already hold the user's actual secrets** in our own credential store (provider API keys, the Core
token, MCP OAuth tokens, git credentials).

**Three tiers, and only the first two are worth building:**

1. **Known values.** Exact-string redaction of secrets we already hold. Zero false positives, no
   ruleset to maintain, and it covers precisely the secrets an exfil would target and the ones a
   user would be angriest to see in a prompt.
2. **Vendor-structured prefixes.** ~20 patterns, not 150 — `ghp_`, `gho_`, `glpat-`, `sk-ant-`,
   `sk-`, `AKIA`, `-----BEGIN * PRIVATE KEY-----`. Several are checksummed (GitHub tokens carry a
   CRC32 in the tail), so they self-validate offline.
3. **Entropy heuristics.** The >50%-FP tier. Skip it, or make it user-declared — the same posture
   already chosen for read-deny patterns.

**The standard differs from a scanner's.** A scanner's false positive burns a human triage cycle;
a redaction false positive means the model sees `[redacted]` where a random-looking string was, and
can ask. A false *negative* is just today's behaviour, not a regression. The change is monotonic,
which is exactly why "we can't catch everything" does not block tiers 1 and 2.

**Never verify a candidate by calling the provider** (TruffleHog's approach — it cuts their false
positives 85–95%). That transmits the user's discovered credential to a third party.

Applies to tool *results*: command output and file reads, before they reach the model.

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
- **Windows path-validation matrix.** Upstream just closed an NTLM credential-leak vector where the
  NT `\??\` device prefix bypassed UNC validation. We have scar tissue here (drive-letter colon,
  `\\?\`) — worth a dedicated test matrix: `\??\`, `\\?\UNC\`, 8.3 short names (`PROGRA~1`),
  `C:relative`.
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
