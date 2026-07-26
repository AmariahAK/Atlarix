# Atlarix TODO

**Current Version:** v14.17.0 (RELEASING 2026-07-26) — Atlarix Core moves off OpenRouter onto the
provider APIs directly (GLM 5.2 + DeepSeek V4 Pro, both ~1M context), billing computed from
models.dev prices, plus the think-tag fix that was folding answers into the Thoughts card.
**Last Updated:** 2026-07-26

## ✅ SHIPPED in v14.17.0

**Core no longer uses OpenRouter at all.** The only OpenRouter left in the product is a user's own
BYOK key. Core calls DeepSeek and Z.ai directly, and the proxy computes cost from token counts x
models.dev prices x 1.4 instead of reading a dollar figure back from a gateway.

- **The billing model changed shape.** models.dev is the single price source — it already carries
  `cache_read`, `cache_write` and context `tiers`, which the source briefs wrongly claimed it
  lacked, so the planned hand-maintained price overlay was never built. One wallet still covers
  every model; each call is priced from its own model's row.
- **Config, not code, decides the lineup.** `core-models.json` gained `routing` + `providers`
  blocks. The `apiModelId` is CARRIED rather than derived, because the wire id and the catalog key
  differ in case (`minimax/minimax-m3` vs `MiniMax-M3`) and the lookup is case-sensitive — deriving
  it silently lost that model's price and context window. Slots parked as `TBA` read as empty, and
  2/3/4-model lineups all work with no release.
- **Per-model reasoning replaced a provider allowlist.** Providers differ in the KIND of control
  (toggle vs effort-list vs budget_tokens), not just the amount. Deep ON asks for a model's true
  max; OFF sits one step below **in that model's own declared values**, so Kimi K3 never receives
  the `medium` it does not list.
- Core context now resolves from models.dev: DeepSeek 128K -> ~1M (compaction ~600K, not ~100K).
- Client dispatches Core via `createOpenAICompatible`; the wire id stays `vendor/model` so
  already-installed clients keep working and the proxy owns the rewrite to the vendor's id.

**Bugs found that the briefs did not mention:**
- The Thoughts card was capturing the visible ANSWER for every `<think>`-emitting model, DeepSeek
  included. Four files normalised the tags the same wrong way. Not latent — live.
- `teeUsageStream` never settled on client-abort or upstream-error (a TransformStream's `flush`
  runs on neither), so a disconnect mid-generation meant the provider billed us and the user was
  charged **nothing**.
- Missing usage was a free generation. Now charges the reserve.
- The OpenRouter path billed a **flat 10c regardless of tokens** — a severe under-charge on large
  generations, and it applied to all traffic while any tier was unrouted. Now bills from
  OpenRouter's own reported cost on that path only.
- The proxy had no models.dev provider-alias map (`qwen`->`alibaba`, `moonshot`->`moonshotai`), so
  the price lookup missed for two tiers and silently billed at the reserve.
- The JWT verifier pinned RS256; this Supabase project issues **ES256**, so it would have rejected
  every token and locked out every user.
- `temperature: 0` was sent to every model always (nothing ever writes the field); Kimi K3 does not
  accept the parameter.

**Also shipped:** citation preview + code-file filtering, per-source background-token breakdown,
browser scroll reporting, Discord avatars/badge, launchpad 404 rebuild.

**REMAINING (owner-side):** reconcile proxy debits against the DeepSeek and Z.ai dashboards over
~a day — that is the acceptance gate and cannot be self-certified. Add Kimi back once its billing
works (one `models` + one `routing` entry). Delete the proxy's temporary retired-model list once
adoption of the new lineup is high.

**GOTCHA:** `atlarix-releases` merging to `main` IS the Core cutover — it is read live by every
installed client. Never merge it before the proxy is deployed.

## ✅ SHIPPED in v14.16.1

- **Sign-in survives a restart (v14.16.0 regression).** Deferring the session restore past
  `createWindow()` was right; the renderer's `plan-changed` handler ended `: prev`, so it could only
  UPDATE an existing status and never ESTABLISH one — the correction was dropped and the user was
  asked to sign in again with a valid session in main. Now re-reads via `checkSession()` (the payload
  carries plan fields only, no identity). Same-effect second fault: `updateSession` resolved
  plan/tier BEFORE assigning `this.session`, so an offline throw left it null and
  `broadcastSessionState()` early-returned.
- **A provider's models appear as soon as its key is saved (pre-existing).**
  `useLanguageModelsByProviders` has a 5-minute `staleTime` invalidated only by the core-models
  event, the manual refresh button and provider CRUD — saving a key was not one of them. Fixed in
  `useSettings.updateSettings` (the one choke point every provider form goes through) rather than in
  `ProviderSettingsPage`, so it covers every provider and any added later. No keys were lost; only
  the display was stale.
- **Discord sign-in** + an unverified-email guard: identity is email-keyed across the users table,
  plan lookups, the realtime channel and billing, so a session with no email is refused with an
  explanation instead of creating a half-account that fails later, far from the cause.
- **Settings → Community** — Discord, PeerPush review, and the acquisition question. Answer stored as
  a PostHog **`$set_once` person property** (so every funnel breaks down by source, and a reinstall
  can't overwrite it) plus a local gate scoped to the **user id**, so a second account on the same
  machine is still asked exactly once.
  - **The PeerPush prompt is DORMANT by design:** `activeDayCount` starts at this build, so nobody
    reaches a second active day for 24h+. Silence is correct — do not debug it as broken.
  - The active-day COUNT is written even when analytics are opted out (it drives an in-app prompt, a
    product decision); only the event is gated.
- **GOTCHA (cost me a silent failure):** `preload.ts` has a `validInvokeChannels` allowlist — a new
  `ipcRenderer.invoke` channel throws `Invalid channel` until it's added. The receive allowlist is a
  separate list.
- **GOTCHA:** `npx tsc --noEmit` at the repo root is a **NO-OP** (solution-style `tsconfig.json` with
  `files: []` + project references). Use `npm run check:ts` or the three `-p tsconfig.*.json`
  configs — the root command exits 0 having checked nothing, and it hid two real type errors.

## ✅ SHIPPED in v14.16.0

Everything in this section shipped in v14.16.0. Do not read the sub-headings as four parallel
workstreams — they are **one release narrative**, see the note below.

**The only genuinely open item** is owner-side packaged-app verification of the catalog work — see
"REMAINING" under *models.dev catalog as the floor*. Nothing is blocked on it.

**These shipped as ONE release narrative, not four.** Specifically:
- *models.dev catalog as the floor* and *provider model accuracy* are the same bug, twice: the
  accuracy pass fixed each pagination/mapping defect individually, then the catalog-as-floor union
  removed the mechanism that produced them. Ship them as one story — the second **supersedes** the
  first, it doesn't sit beside it.
- *Voice transcription de-hardcoded* is the same de-hardcoding arc applied to STT model resolution;
  it belongs with the catalog work, not on its own.
- The remaining items (plan-ledger desync, sub-agent render duplication, `edit_file` escaping) are
  independent agent-loop/rendering fixes and can stay as their own bullets.

### 🌐 Browser tooling — ergonomic gap close (SHIPPED v14.16.0)

**Supersedes the old "Browser tooling convergence" plan.** That plan's Stage 2 reader rework
(deleting `mode:"snapshot"`/`mode:"text"`, tree-with-depth, subtree scoping, `max_chars`) and the
`preview_test` → `browser_test` rename were **dropped** — the combined read default below gets the
same practical win with none of the migration risk, and the rename cost two eval suites for nothing.

**The finding that reframed it.** A live packaged-app run (v14.15.0, Hacker News) showed the browser
tools working exactly as intended: the agent chose `mode:"visual"`, got real axe results (812
elements, 242 contrast nodes, CLS 0.000) and answered well. Atlarix is *aligned* with the market
(a11y-tree first, screenshots as fallback — same as Playwright MCP / browser-use), and its
`visual`/`design` lint is ahead of them. So the remaining gaps are **ergonomic, not perceptual**:
the agent reaches for a screenshot when it can't FIND or REACH something, not when it can't see.

- **Multi-tab.** New `browser_tabs` (`list`/`create`/`switch`/`close`) exposing the lifecycle that
  already existed in `browser_view_manager.ts` for the UI. `tab_id` threads through navigate /
  inspect / interact / find / batch. **The panel follows the agent** (create + switch make the tab
  active and visible, like a real browser) — which is also what keeps every tab's viewport correct,
  so no paint-host machinery was needed.
- **Ambiguity is a hard, self-correcting error.** `tab_id` is schema-optional (no tax on the common
  single-tab turn) but the handler refuses when it's omitted with >1 tab open, listing the tabs so
  the model fixes it in one retry. Every result echoes `tab: {id, url}` — a wrong-tab action is
  visible, never silent.
- **`browser_find`** — element lookup by description, ranked **heuristically in the page** (role +
  accessible name + text). No LLM call: deterministic, free, instant. 20-match cap that says so.
- **`browser_interact` gained `key`, `hover`, `scroll`** and typed `fill` (boolean toggles a
  checkbox; a `<select>` matches by option value **or visible text**). **`key`/`hover` MUST use
  `webContents.sendInputEvent`** — Enter-to-submit and CSS `:hover` only respond to TRUSTED events,
  so a dispatched `KeyboardEvent`/`MouseEvent` looks right in code and silently does nothing.
- **`browser_batch`** — several predictable steps in one call, sequential, halts on first failure,
  refs only. `preview_test` keeps its own assertion path unchanged.
- **Combined read default** — `browser_inspect` with no mode returns page content AND refs in one
  call; `filter:"interactive"` narrows to controls. **Nothing was deleted**: `snapshot`, `text`,
  `visual`, `design`, `console`, `screenshot` all still work, so no prompt sweep or eval re-pinning.
- **`mode:"network"`** — exposes the already-captured failed (4xx/5xx) requests. A full request log
  is deferred; `webRequest.onCompleted` records only failures by design.

**Two silent correctness bugs fixed on the way (both pre-existing):**

- **Refs were reassigned by DOM walk order on EVERY read**, so inserting a node near the top shifted
  every later ref — `e7` became a different element and a click landed on the wrong thing. Now a
  `WeakMap` in the **page realm** (`window.__atlarixRefs`, mirroring `window.__atlarixCLS`); it has
  to live there because a WeakMap keyed on DOM nodes can't be held in main, which also means it
  resets naturally on navigation. Truncation now reports the REAL total ("showing 200 of 1,340")
  instead of the cap, which had made a truncated read look complete.
- **A view whose rect doesn't intersect the window gets a 0×0 layout viewport** — the document still
  lays out, at zero width, so geometry answers are plausible and WRONG. Reachable because the first
  agent navigation attached the tab before the renderer's `ResizeObserver` had reported bounds
  (`lastBounds` null → `setBounds` skipped). Fixed with a `fallbackBounds()` derived from the host
  window, plus `setVisible` before `ensureTab`, plus a guard that refuses a 0-width read instead of
  answering from it. **`capturePaintable`'s `OFFSCREEN_RECT = {x:-20000}` never worked** for this
  reason — measured across four Electron 38.2.2 probes; it appears to work only because a
  previously-visible tab retains its last painted frame.
- **Every geometry-bearing read now reports its viewport.** The live HN capture was 798×1338 physical
  = a ~399 CSS-px viewport: the agent judged the page at whatever width the user had dragged the
  panel to, with nothing in the output disclosing it.

**REMAINING (owner) — packaged-app verification:** multi-tab state preservation (log in on tab 1,
open tab 2, switch back, still logged in); `key`+`"Enter"` submits a form; `hover` opens a CSS
`:hover` menu; `browser_find` returns a usable ref without a full read first; a `tab_id`-less call
with two tabs open returns the listing error rather than guessing.

**The real success measure:** watch whether screenshot usage drops in real turns. That — not
speculation — is what should decide whether any further *perception* work (exact colours, contrast
ratios, occlusion, responsive multi-width diffing) is worth doing. Deliberately out of scope here;
the honest argument for it is that computed style cannot be derived from the repo (unlike the
blueprint tool, which restated what was already on disk), but the argument for *building it now* is
not yet evidenced.

### Offline resilience — the app opens without a network

**THE INVARIANT (do not quietly revert):** **window creation must NEVER await a network call.** Adding
"just one await" before `createWindow()` in `main.ts` reads as harmless and reintroduces the exact
bug below. The deferred block after `createWindow()` is where startup network work belongs.

- **The reported symptom was "the app doesn't open"; the cause was a HANG, not an error.**
  `restoreAuthSessionOnStartup()` + `SubscriptionManager.initialize()` both ran before
  `createWindow()`, both hit Supabase, neither was timeboxed. The `try/catch` around them looked
  protective and did nothing — **a hang is not an exception.** Behaviour split by *how* you're
  offline: cleanly offline (DNS fails instantly) was survivable; a **black-hole network** (captive
  portal, hotel wifi, VPN — DNS resolves, TCP never completes) hung each request to the OS TCP
  timeout (~75s on macOS), and the refresh retried 3× with `[0,1s,3s]` backoff. Minutes with **no
  window**. Now deferred past `createWindow()`, mirroring `warmCoreModelOverrides`.
- **Renderer correction reuses the existing `plan-changed` channel** (broadcast → `preload.ts:346`
  allowlist → `subscribePlanChanged` → `useAuth`). New `SubscriptionManager.broadcastSessionState()`
  fires it once the deferred init lands, so the UI flips from signed-out to signed-in. **No new IPC.**
  The duplicated `BrowserWindow.getAllWindows().forEach` was collapsed into one
  `broadcastPlanChanged()` so the payload can't drift between the two call sites.
- **8s per-request deadline on the Supabase client** (`fetchWithTimeout`, composed with any caller
  signal via `AbortSignal.any`). Stage 1 only protects startup; this protects sign-in, plan refresh
  and the hourly token refresh too. It's what makes the codebase's existing `catch → return 'free'`
  handling *reachable* — that code was always correct and simply never ran on a hang. Realtime
  websockets untouched (their heartbeat tuning is deliberate).
- **Offline entitlement** (`src/lib/auth/offline-entitlement.ts`). `getUserPlan` returned `'free'` on
  ANY error and `_tierCache` was in-memory only → an offline Pro user was silently downgraded for the
  session. Now `lastKnownEntitlement` is persisted on the authoritative path and read **only when a
  request failed**, honoured until `subscription_ends_at`. Scoped by `userId` (shared machines),
  cleared on sign-out, and **a record with no end date is NOT honourable** — absence of a boundary
  must never grant an unbounded entitlement, which is the failure mode you'd find months later and in
  the direction of giving the product away. A reachable server with no row still means `'free'`; the
  cache is consulted on failure, never on a successful empty result.
- **Already offline-capable before this** (so the gap was sequencing, not capability): local Whisper,
  bundled ripgrep, SQLite, the agent loop, terminal, and the models.dev bundled snapshot.
- **REMAINING (owner):** black-hole verification — null-route Supabase (`/etc/hosts` → `10.255.255.1`
  or `pfctl`) and confirm the window still appears instantly; confirm an offline Pro user stays Pro
  across a restart.

### Dictation accuracy + voice settings + analytics correctness

Four issues from packaged-build testing. Unrelated in code, same cause: small things left behind that
quietly produce a wrong result.

- **Dictation accuracy — four compounding causes, not one.** The model (`whisper-base` → `whisper-small`,
  `whisper-worker.ts`) was the headline, but three capture-side defects mattered nearly as much and cost
  nothing: (a) `getUserMedia({ audio: true })` accepted the browser's **call-tuned** DSP — `noiseSuppression`
  and `autoGainControl` default ON and both hurt ASR by reshaping the spectrum Whisper trained on; now
  explicitly off at mono 16 kHz. (b) **`language` was never passed** by `VoiceInputButton`, so Whisper re-ran
  language DETECTION on every clip — unreliable on short dictation, and a wrong guess wrecks the whole
  utterance. New `resolveVoiceLanguage` (`src/lib/voice/language.ts`) resolves setting → OS locale →
  detection; **not** a hardcoded `"en"`. (c) greedy decoding → `num_beams: 4`.
  Also fixed a latent bug: `transcribe` resolved `DEFAULT_MODEL` rather than the model `load` asked for
  (harmless only because the pipeline promise is memoized).
  **Cost: ~206 MB → ~409 MB one-time model download.** Owner chose the pinned bump over a model picker.
- **Voice settings surfaced** (`VoiceInputSettings.tsx` → Settings → AI). Engine/language/mode, reusing
  `useTranscriptionProviders` — the composer dropdown and Settings read the same setting, so one source
  of truth, two doors.
- **Dead `team` nav entry deleted** (`SettingsList.tsx`). Comment added: every id must match a real
  `<div id="…">` in `settings.tsx`, since the sidebar scrolls by id and an orphan is a silent no-op.
- **Analytics: the reported bug was false, the real one was worse.** "The two SDKs may not share a
  distinct ID" — they always did (`getOrCreateAnonymousId` feeds both). The actual defect was **no
  `alias()` anywhere**: a per-install UUID never linked to the Supabase user, so one human on two
  machines was two people and a reinstall minted a third. Every per-user number was inflated in a way
  no dashboard filter could repair. Now `identifyUser` (`analytics.ts`) aliases once per install at
  sign-in via `SubscriptionManager.updateSession`, `resolveDistinctId` attributes everything after to
  the user id, and the renderer follows via `PostHogIdentityBridge` (uses the existing `useAuth` hook —
  no new IPC needed, unlike the plan assumed).
  - **PII leak fixed:** `extra-files:*` sent an array of **absolute paths** (project structure + OS
    username), directly contradicting the consent copy. Now a count.
  - **`app_launched` deleted** — duplicate of `app_opened` six lines later; every launch double-counted.
  - **`action:*` and `extra-files:*` RENAMED, not deleted.** I had them down as dead leftovers; they are
    live (`AtlarixMarkdownParser.tsx:685`, `useStreamChat.ts:1467`). Deleting would have destroyed real
    instrumentation — a second opinion caught this.
  - **Local providers never entered the funnel** — Ollama/LM Studio need no API key, so they never hit
    the handler that fires `model_connected`. Now fire `{ type: "local" }` once per provider.
  - Added `active_day`; `persistence` `memory` → `localStorage+cookie`.
  - **NOT done:** provider class (`core`/`byok`/`local`) on `task_completed` — `TurnRuntime` carries no
    provider id and threading one through was out of proportion to the value, since `model_connected`
    already answers Core-vs-BYOK. Revisit if per-turn segmentation is actually needed.
- **REMAINING (owner):** packaged-app verification — dictation A/B; sign-in alias merge confirmed in the
  PostHog UI (not a second profile); opted-out still sends zero requests.

### models.dev catalog as the floor

**THE INVARIANT (do not quietly revert):** the models.dev catalog is the BASE list for every cloud
provider. A provider's own `/models` response is a best-effort OVERLAY that may only **add** models or
**refine** fields. It must never be able to shrink the list. Enforced by `mergeByApiName`
(`src/lib/models/merge-provider-models.ts`), locked down by `provider-catalog-merge.test.ts`.

- **The bug class this closes.** `language_model_helpers.ts` used to be exclusive — native fetch wins,
  catalog consulted ONLY if native *threw*. Every recent bug was a fetcher that **succeeded with a
  wrong list**: Anthropic's `limit` defaults to 20, Google's `pageSize` to 50, Cohere's `page_size` to
  20. All returned truncated lists at HTTP 200, so nothing threw, the fallback never fired, and the
  picker lost models while the correct answer sat in memory. Bedrock listed zero because it was absent
  from `FETCHERS` *and* from `PROVIDER_ID_MAP`. Fixing each pagination bug individually left the
  mechanism intact; the union removes it.
- **Catalog made load-bearing first** (`src/lib/models_dev.ts`) — it can't be the floor if it can
  vanish. (a) Bundled snapshot tier: memory → disk cache → **bundled snapshot** → network. Cold
  offline start used to resolve to `{}` (empty provider list AND empty picker). `build/models-snapshot.json.gz`
  (~300 KB gzipped, ~170 providers) ships via `extraResource`; regenerate with `npm run models:snapshot`
  — **committed deliberately, not fetched at build time**, so packaging never depends on models.dev
  being reachable. (b) **Atomic cache write** (temp + `rename`): the direct `writeFile` truncated the
  live cache under the disk-full condition behind Sentry `49d4f2a5`, losing all 169 providers on the
  next boot. (c) 2 retries with jittered backoff; aborts are NOT retried (budget already spent).
  (d) Boot fetch skipped when the cache is < 5 min old.
- **Fetchers pruned to those that know something the catalog can't.** Deleted `cohere`, `mistral`,
  `xai`, `together`, `groq` and the `nvidia_nim`/`cerebras`/`huggingface` wrappers — each produced a
  strict SUBSET of catalog rows with worse display names. Kept `openai`/`anthropic`/`google` (day-one
  launches), `openrouter` (live pricing + `top_provider` ceilings), the open-weight four (Core tiers,
  ship weekly), and **`elastic` — which has NO catalog rows at all** (it lists Kibana agents from a
  user's self-hosted instance, so native is its only source and the empty floor is correct; asserted
  by test so a future "every provider has a floor" refactor can't break it). Adding a fetcher back
  needs one of those reasons — "the provider has a `/models` endpoint" is not one.
- **Accepted trade-off:** an entitlement-scoped provider (OpenAI gates some models by org tier) may
  list a model the key can't call, which 403s at call time. A visible error beats a silently missing
  model, and it matches how the ~145 catalog-only providers already behaved.
- **Launchpad de-enumerated.** The hand-typed provider lists ("…Groq, Mistral, xAI, Hugging Face,
  Azure, Bedrock") in `Docs.tsx`, `helpDocs.ts`, `FeatureStrip.tsx` and `ProviderFreedom.tsx` were a
  standing staleness source. Replaced with live figures (145+ providers, 4,400+ tool-capable models —
  rounded DOWN from the measured 145/4,480 so the claim survives catalog drift). Voice copy still
  names OpenAI/Groq/Gemini as examples — accurate, since those remain the common BYOK STT keys even
  though the picker itself is now catalog-driven (see *Voice transcription de-hardcoded* below).
- **REMAINING:** owner packaged-app verification — offline cold start populates from the snapshot;
  Anthropic/Google/Cohere list their full families; a pruned provider (Groq or Mistral) still runs a
  real tool-calling turn.

### Provider model accuracy + citation render + sub-agent status (partly SUPERSEDED — see above)

> **Read this second.** The provider-listing half of this section was the *first* attempt at the bug
> that *models.dev catalog as the floor* later solved structurally. The `PROVIDER_ID_MAP` repair and
> the `annotateToolCapability` funnel **still stand** — they're load-bearing under the union. The
> per-provider pagination fixes below are **dead code for five providers** (cohere, mistral, xai,
> together, groq: fetchers deleted) and defensive-only for the rest, since a truncated response can no
> longer shrink the list. Kept as the record of why the union exists; do not present it as a separate
> shipped feature.

- **Provider ID map repaired (`src/lib/models_dev.ts`).** `bedrock` → `amazon-bedrock` and
  `nvidia_nim` → `nvidia` were missing from `PROVIDER_ID_MAP`, and everything routes through
  `resolveModelsDevProviderId`. Consequences: **AWS Bedrock listed ZERO models** (no native fetcher, so
  models.dev is its only source — ~109 tool-capable models were invisible), and **NVIDIA NIM lost all
  limit/cost enrichment**, so its 84 models fell back to the generic 200K context guess with no price.
  Inverse entries added to `REVERSE_PROVIDER_ID_MAP` — without them the long-tail catalog emits
  `amazon-bedrock`/`nvidia` as SEPARATE providers that don't de-dup against the built-ins (duplicate
  rows in the picker).
- **Shared tool-capability funnel — `annotateToolCapability`.** The models.dev path always gated on
  `tool_call`; the native fetchers never did, so the "first-class" providers leaked non-tool models
  (NVIDIA 84→45, OpenRouter 341→270, Groq 15→7, OpenAI 56→46, Google 25→18, xAI 9→5, Cohere 14→9)
  while the 145-provider long tail stayed clean. One funnel in `fetchModelsFromProvider` covers all 19.
  **A model the catalog doesn't know is KEPT** — native fetch exists to beat the hourly catalog, and
  dropping unknown ids would trade an accuracy bug for a freshness bug. Catalog empty/unknown provider
  → input untouched.
- **Per-provider fixes.** Anthropic paginates (`limit` defaults to **20**) + now uses its authoritative
  `max_input_tokens`/`max_tokens`; Google paginates (`pageSize` defaults to **50**) + key moved to the
  `x-goog-api-key` header; Cohere paginates (`page_size` defaults to **20**) + `endpoint=chat` +
  skips `is_deprecated`; OpenRouter uses `?supported_parameters=tools` + `top_provider` ceilings;
  OpenAI's prefix allowlist → substring denylist (it dropped bare `o3`/`o4-mini` while admitting
  `gpt-image-*`/`gpt-realtime-*`/`*-transcribe`); xAI moved to `/v1/language-models` with a
  `/v1/models` fallback; Perplexity's hardcoded array → live catalog rows marked
  `supportsToolChoice: false` (models.dev marks every Sonar model `tool_call: false` — correctly; the
  old list claimed the opposite and omitted the real 128K/200K limits).
- **Citation strip renders (the 14.14.1 fast-follow).** Root cause found: `isStructured` is true when
  content has `<think>` or a tool-call tag, which routes rendering through the interleaved branch of
  `AssistantMessageBody.tsx` — and the v14.14.0 `MessageSources` mount was in the *legacy* branch, which
  only plain-prose turns reach. **Every turn that actually searched has a tool-call tag**, so the strip
  never showed for exactly the turns that had citations. Mounted in both branches; the existing test
  passed because its fixture was plain prose.
- **Sub-agent status no longer claims false completion.** `SubAgentRunCard`'s icon and
  `SubAgentsRoundPanel`'s header both treated "not running" as done via an else-branch, so a sub-agent
  that had only just spawned rendered with the green completed check. Completion now requires an
  explicit `done`/`error`; anything unrecognized shows as still working.

### Plan-ledger desync + voice de-hardcoding

- **The agent no longer fights its own plan.** Observed in a real session: the agent marked 25 of 31
  steps done inside one turn while the injected ledger kept asserting the turn-START counts
  ("2/31 steps done", all 29 listed as remaining), concluded its own tracker was broken, rewrote the
  plan and re-marked every step in a loop. Cause: `simple-stream-text.ts` injected the ledger only at
  `stepNumber === 0`, from a snapshot taken during context assembly — so mid-turn progress could
  never be reflected. Verified against the live app DB (one plan row; the competing-artifacts theory
  was wrong) and by running the real parser over the session's plan content (31 steps, only 2 as
  numbered checkboxes — hence the "2").
  - New `plan-ledger-refresh.ts`: plan mutations pre-render a fresh ledger keyed by chat, drained
    take-once on the next step (`prepareStep` is sync, so it can't re-read the DB). Unchanged plan →
    still injected once, so quiet turns cost nothing.
  - `plan(update_step)` now returns `progress` on the **no-op** branch too — that branch fires exactly
    when the model has lost track, and omitting the counts left it nothing to self-correct with.
  - **`operation:'write'` no longer forks the plan.** Without a `planId` it used to INSERT a new
    artifact, and weak models routinely drop the id (which is why it's optional) — so the documented
    "rewrite the whole plan" escape hatch silently created a second row, after which the tool updated
    one plan while the ledger read another. It now updates the in-flight plan in place, creating a new
    artifact only when nothing is in flight (no plan, or the last is `built` = a genuinely new task).
    The escape hatch stays open — deliberately, so a model that can't text-match a step is never
    cornered — it's just actually safe now.
  - `resolvePlanId` aligned with `loadActivePlanSection`'s building-first selection so the tool and the
    ledger can never target different rows.
- **Voice transcription de-hardcoded.** `voice_handlers.ts` had a closed `"openai" | "groq" | "gemini"`
  allowlist and pinned model ids (`gemini-2.0-flash` had already aged out) — the same rot the model
  pickers were just taken off. Now: any provider id, with the STT model and API base URL resolved from
  the models.dev catalog by **audio-input modality** (71 providers expose one) via new
  `getAudioInputModelIds` / `getProviderApiBaseUrl`, falling back to the previous ids when the catalog
  is unavailable. Gemini's key moved from the query string to the `x-goog-api-key` header (matching the
  Google model fetcher). Settings schema relaxed from an enum to a free-form id so a new provider needs
  no schema change.
  - **The composer picker is de-hardcoded too — DONE** (commit `c2311b2d`). New
    `voice:list-transcription-providers` IPC builds the menu in main from (providers with a key) ∩
    (providers exposing an audio-input model), collapsing gemini/google and always leading with
    on-device; `useTranscriptionProviders` feeds `ChatConfigDropdown`. The curated four still in
    `ChatConfigDropdown.tsx:71` is **only the loading/error fallback**, not the live list — voice must
    never present an empty picker. Covered by `transcription-providers.test.ts`.

### Sub-agent duplicates, voice picker, edit_file escaping

- **Delegate rows no longer duplicate under the sub-agent panel.** A settled delegation rendered its
  round panel AND a separate collapsed "Sub-agent finished" row per agent. Root cause was drift in one
  predicate: the registered delegate tool is `task` (`spawn-task.ts:187`), but `isDelegateToolName`
  (`delegate-handoff.ts`) knew only `delegate_to_agent`/`spawn_sub_agent` — so it returned **false for
  every real delegation**, silently disabling delegate-part filtering, the round panel's split
  position, and round synthesis at once. (`group-stream-tools.ts` already listed all three, which is
  what marked it as drift.) Fixing the predicate alone wasn't enough — neither tail builder filtered
  delegate rows, and a native-FC delegation has no content tag so it always looked "not represented".
  Both tails now drop delegate rows **only when a round panel exists** to represent them; with no
  panel the delegate card is the only record and still renders.
- **Voice picker lists every configured audio-capable provider.** New
  `voice:list-transcription-providers` builds the menu in main from (providers with a key) ∩
  (providers exposing an audio-input model), collapsing gemini/google, always leading with on-device,
  and falling back to the old curated list while loading/errored.
- **`edit_file` no longer blocks valid files that merely quote a newline.** Writing an ordinary
  multi-line file was rejected as "partially over-escaped" when it contained a regex literal like
  `/^---\n([\s\S]*?)\n---/`, a `join(',\n')`, or a template ending a line with `},\n` —
  `STRUCTURAL_LITERAL_NEWLINE` matches a terminator followed by a literal `\n`. The content was
  already correct, so **no re-send could satisfy the error**, and the retry loop pushed the model into
  shell heredocs that cascaded their own escaping into genuinely broken output. Over-escaping is a
  per-argument failure (a model that escapes newlines escapes all of them — which is why the
  confident `repair` case requires ZERO real newlines), so content dominated by real breaks is not
  collapsed. `ambiguous` now requires ≥ half the intended breaks to be literals; the populations
  separate cleanly (legit source ≈ 0.2–0.25, genuine half-escape ≥ 0.5). Failure modes are
  asymmetric — a false block is unrecoverable, a false pass is visible in the diff.
- **Sub-agent panel renders on plain-prose messages too.** A `subagent_round` on a message with no
  tool/think tags rendered NOWHERE: the legacy branch never rendered `inlineSubagentRound` (only the
  interleaved one did), and post-stream that value is non-null regardless of branch — because
  `resolveLiveSubagentRound` reads the COMPLETED thread once streaming ends — which then also
  excluded the round from the tail. Unreachable via a real delegation (those emit tool tags, forcing
  the interleaved branch), but a message body must never silently drop a sub-agent run.
- **Flaky-gate fixes.** (a) The real-I/O compaction tests got a 30s budget (the slowest runs ~3.3s
  against the default 5s and tipped over under parallel load). (b) The agent-eval turn budget and
  the eval project's `testTimeout` were BOTH 30s, so they raced — vitest winning replaced the
  helper's "Recorded channels: …" diagnosis with a bare "test timed out". One named
  `AGENT_TURN_TIMEOUT_MS` (45s) now drives `waitFor`/`runTurn`, the project timeout moved to 90s so
  the informative error always wins, and the invariant is documented at both ends. `waitFor` is a
  hang detector, not a speed limit: these turns drive the real loop against real sqlite (~13.5s idle
  for the slowest) while three vitest projects compete for CPU.

## ✅ Shipped in v14.15.0

- **Preview tab removed; unified on the Browser** — app runs in a Browser tab; error capture migrated onto
  tabs + injected `[[ATLARIX_ERR]]` stack hook; clickable/linkified URLs (incl. `localhost:PORT`) open tabs.
- **Per-job live wake timer** — `background_jobs` `wake_in`/`adjust_timer` + `wake_in_s`; auto-cleared on finish.
- **Screenshot capture fix** — `browser_inspect(screenshot)` via `capturePaintable` works with the panel hidden.
- **Universal sandbox write-escalation** — existence-prune fix + escalation-on-denial (re-run still sandboxed),
  reusing `workspaceFilePermissions`/`sandbox_path`; CI fails loud on a non-compiling native helper.
- **Supabase idle-ping reduction, keyboard shortcuts (Cmd+T/W/J/I/O), device-spec injection, allow_stalled,
  code-block render fix.**

## ⏳ Open / deferred

### 🔀 `AssistantMessageBody` two-branch duplication (own session)

`AssistantMessageBody.tsx` returns from two structurally parallel branches — interleaved
(`useInterleavedTimeline = contentDrivenThread || isStructured`) and legacy — and features get wired
into one but not the other. **Two bugs from this class shipped in a single batch:**

- The web-search **citation strip** was mounted only in the legacy branch, so it never rendered for
  the turns that actually had citations (every search emits a tool tag → interleaved branch).
- The **sub-agent round panel** was the mirror image: rendered only in the interleaved branch, so a
  round on a plain-prose message rendered nowhere. Worse, `excludeSubagentRound` — driven by
  `inlineSubagentRound`, which `resolveLiveSubagentRound` makes non-null post-stream by reading the
  COMPLETED thread — pulled the round out of the tail too, closing the one indirect route the legacy
  branch had (via `StreamThreadItemView`'s `case "subagent_round"`). Git history confirms the legacy
  branch NEVER had its own panel render; it was an omission from the split, not a regression.

Both are fixed, but the shape guarantees recurrence: any future "render X at the tail" lands in one
branch and silently misses the other, and there's no test that asserts parity.

**Direction:** collapse the two returns into one. The branches differ mainly in how they order
content (woven timeline vs. parts list + tail); the trailing concerns — citation strip, sub-agent
panel, permission approvals, trailing answer — are identical and should be emitted once, after the
branch-specific middle. Failing that, a parity test that renders the same fixture through both
branches and asserts the same trailing elements appear.

### Other

- **Sub-agent results still don't *continue* in the timeline.** The duplicate tail rows are fixed
  (see below), but results still live inside the round-panel cards behind the expand affordance
  rather than resolving inline where they were spawned. Owner chose the minimal fix for now;
  revisiting means weaving settled `subagent` items via `weaveIpcItemsIntoParts` and collapsing the
  panel once all agents settle, so the same agent isn't rendered twice.
- ~~agent-evals flakiness~~ — **FIXED** (see the in-progress section above).

- **Linux authoritative denied-path supervisor — Phase 2 (WRITTEN, compiles, feature-gated OFF; pending dev validation).**
  `native/atlarix-sandbox-linux` gained a ptrace + seccomp(`SECCOMP_RET_TRACE`) supervisor that records
  write syscalls to paths outside the writable roots into a `--deny-report` file — for tools that swallow
  the path. **Feature-gated OFF** (`trace-supervisor`; optional nix/libc/seccompiler deps) + runtime-gated
  (`ATLARIX_SANDBOX_TRACE=1`) + graceful fallback, so the default build is unchanged and the sandbox can
  never break. `cargo check --target {x86_64,aarch64}-unknown-linux-gnu` clean with/without the feature.
  - **REMAINING:** (1) real-Linux dev-hardware runtime validation (does it capture denials, trace forked
    children, propagate exit codes?) — build `--features trace-supervisor` + `ATLARIX_SANDBOX_TRACE=1`;
    (2) production report-file threading (`wrap-command.ts` passes `--deny-report` + the interceptor
    prefers the report over stderr-parse) — land with the validation; (3) flip the feature on in CI once
    green. Windows stays stderr-parse (ETW needs elevation).

## ⏳ TBD / Next (fast-follow 14.14.1)

- **Owner-side verification (from the v14.14.0 web-search work):** (1) billing A/B — confirm OpenRouter
  `usage.cost` includes the ~$0.005 search fee so the wallet debit = `ceil(cost × 1.4)` (else add a proxy
  surcharge in `atlarix-proxy/src/server.ts`); (2) per-Core-model check that DeepSeek/Qwen/Kimi/MiniMax
  reliably emit `openrouter:web_search` — set `webSearch:false` in `core-models.json` for any that don't.


## ✅ Shipped in v14.14.0 (2026-07-20) — outside-workspace tool access + prompt/tool-description trim

Removes the friction that forced `sed`/`python` shell edits: the agent needed to read/patch files in a
tree *outside* the opened workspace (e.g. an upstream dep in `/tmp`), but `read_file`/`grep`/`glob`/
`edit_file` were all hard-confined to the workspace.

- **Workspace is now a default SCOPE, not a wall.** New `resolveToolTargetPath`
  (`src/ipc/utils/safeWorkspaceRelativePath.ts`): a **relative** path stays confined as before; an
  **explicit absolute** path targets that exact location (realpath'd, classified `isOutsideWorkspace`).
  - **Reads auto-allow anywhere** — `read_file` (absolute path → read directly, supersedes the legacy
    tool-output-spill branch), `grep`/`glob` (absolute `path` → root ripgrep there). No prompt (reads
    don't mutate; consistent with the reverted read-file secret-block).
  - **Edits gated anywhere** — `edit_file` accepts an absolute outside path but still returns the
    `permissionPayload` diff/approval gate (never a silent write); `assertReadableUnlessOutside` skips
    the confinement only for the intentional outside target. Plan mode still refuses non-`.atlarix` edits.
  - `run_command` unchanged (sandbox already grants `/tmp`); arbitrary non-`/tmp` outside roots via shell
    deferred. Optional sensitive-read denylist (`~/.ssh`, `*.pem`) deferred — owner chose full auto-allow.
- **Prompt/tool-description trim (~475 words, capability-first, no over-steer):** `run_command`
  description ~476→~140 words (kept capability + background/wake_on/preview + "use glob/grep not shell",
  cut the repeated hand-holding); merged the triplicated "verify before you stop" in the Build `work_mode`
  (base `AGENTS.md` keeps the authoritative copy; kept the unique anti-flail); compressed `BROWSER_NOTE`.
  Left `grep`/`glob`/`read_file`/`edit_file` prose alone (already lean) and did NOT touch the mode
  CAN/CANNOT gating or the `tool_contract` security block. (CAN/CANNOT de-triplication deferred as
  higher-risk.) Two eval tests re-pinned to the new wording (same intent).

## ✅ Shipped in v14.14.0 (2026-07-20) — web-search citations render + dead compass-usage removal

Follow-ups from the Core web-search packaged test (search worked, but no citation chips + a dead-RPC log
error every Core turn).

- **Citation sources render.** Root cause was rendering, not capture — Core replies already persist
  `<atlarix-sources>[{url,title}]` (confirmed from the real DB row), which `extractInlineSourcesFromContent`
  already parses; nothing rendered it (the `MessageSources` grid was orphaned; only inline `[^n]` chips were
  wired, and the model doesn't emit `[^n]`). Fix: mount `MessageSources` at the tail of
  `AssistantMessageBody.tsx`, fed by the already-computed `citationSources`, gated `!isStreaming` — robust,
  model-independent. No capture/parser change; nothing deleted. Test added for the Core `<atlarix-sources>`
  shape.
- **Removed the dead `compass_usage` (old monthly-token-limit) system.** It logged
  `get_compass_usage_state ... schema cache` every Core turn — the RPC/table were already dropped in Supabase
  (`20260714130000_pricing_reframe_teardown.sql`); the current PAYG wallet (proxy `get_credit_balance`/
  `debit_wallet`) is the sole enforcement. Deleted `compass_usage.ts`, `compass_enforcement.ts`, the orphaned
  `compass:get-usage` IPC, the preflight/mid-turn recording + `COMPASS_LIMIT_STREAM_STOP` sentinel + ctx
  fields; relocated the live token-normalization helpers to `src/lib/usage/ai-usage.ts`. Kept
  `compassExhaustedUserMessage` (still used by the CURRENT wallet `402 insufficient_credit` path). No Supabase
  change.

## ✅ Shipped in v14.14.0 (2026-07-20) — Atlarix Core web search (metered into the wallet)

All Core users now get web search out of the box — **model-invoked** via OpenRouter's agentic
`openrouter:web_search` server tool (pay only when the model searches, unlike the always-on plugin),
billed through the existing Core wallet at the standard **40% markup**, citations rendered, **no
SearXNG required**.

- **Enablement** (`src/ipc/utils/native_web_search.ts`): new `case "compass"` returns the OpenRouter
  server tool via the module-level `openrouter.tools.webSearch({ maxResults: 5 })` — mirrors the
  existing `anthropic.tools.*` pattern and reuses the `kind:"tool"` dispatch/citation path
  (`simple-stream-text.ts`), so no dispatch-loop or citation changes. Core reuses the same
  `@openrouter/ai-sdk-provider` (via the proxy), so `url_citation` → `source` → `<atlarix-sources>`
  flows unchanged.
- **Cost folds in automatically:** the proxy already meters OpenRouter's real `usage.cost × 1.4` and
  debits idempotently (`atlarix-proxy/src/server.ts`, `entitlement.ts`) — the ~$0.005/search fee rides
  inside `usage.cost`, so no wallet/Supabase/margin changes. Uses the **server tool, not `:online`**
  (the proxy allowlist is exact-match on the clean model id).
- **Per-model opt-out (no hardcoding):** gated per Core tier via a new optional `webSearch` map in the
  hosted **`core-models.json`** — e.g. `"webSearch": { "core-3": false }` keeps that tier on the client
  `web_search` (SearxNG) tool. Default = enabled; parsed by `core-model-overrides.ts` →
  `core-model-override-store.ts isCoreModelWebSearchEnabled`. Owner-updatable without an app release.
- **OWNER VERIFY before release:** (1) **A/B cost test** — one Core search-triggering call vs one
  without; confirm `usage.cost` rises ~$0.005 on search and the wallet debit = `ceil(cost × 1.4)`.
  If the fee is NOT in `usage.cost`, add a flat surcharge in `atlarix-proxy/src/server.ts`. (2)
  **Per-model invocation test** — confirm each Core model emits `openrouter:web_search`; set
  `webSearch:false` in `core-models.json` for any that under-invoke. (3) packaged-app smoke.
- **Out of scope:** BYOK OpenRouter stays on the always-on plugin (per decision); SearXNG stays as the
  non-Core / opted-out-model fallback (no reliable keyless replacement exists — Bing API dead, Brave
  free tier removed, DDG flaky).

## ✅ Shipped in v14.14.0 (2026-07-20) — permission-write resilience + dynamic sandbox roster + dep de-dep

Root-caused Sentry `49d4f2a5` (`execute-permission` → `SqliteError: unable to open database
file`). Proven from the machine's `main.log`: a large `pnpm install` (vercel/ai monorepo) filled the
disk → SQLite couldn't create its rollback `-journal` → `SQLITE_CANTOPEN`.

- **Best-effort permission-preference writes (the fix).** Persisting an "always allow" rule is
  bookkeeping and must never block the approval. New `persistPermissionPreferenceSafely` /
  `isStorageCapacityError` (`src/ipc/handlers/permissions/persist-safe.ts`) wrap the command/file
  upserts in `execute-permission` (`permissions/handlers.ts`); a failed write logs + degrades (command
  still runs) instead of throwing out of IPC and wedging the turn. Same graceful stance as the
  `[partial-draft]` path and opencode's `Effect.ignore` bookkeeping writes. Sibling handlers
  (`command-permissions:upsert`, `file-permissions:set`) now return `{success:false}` instead of
  throwing. Command-agnostic — pnpm was the trigger, not the target.
- **Disk-full user notice.** On `SQLITE_CANTOPEN`/`SQLITE_FULL`/`ENOSPC`, a one-time (debounced)
  `showAgentNotification` fires so a full disk isn't a silent hang.
- **Dynamic sandbox writable roster.** `wrap-command.ts` now resolves each toolchain's store/cache from
  its standard env var first (`PNPM_HOME`, `npm_config_cache`, `CARGO_HOME`, `GOPATH`/`GOMODCACHE`,
  `XDG_*`, …) then falls back to known dirs — fixes pnpm installs stalling on denied writes to its real
  store (`~/Library/pnpm/store`, previously uncovered). Still zero command-name matching; the sandbox
  stays a generic write boundary. Confirmed by a harness-wide hardcoding audit (no violations found).
- **Conservative dep de-deprecation (build-time only).** Removed the vestigial eslint stack (eslint@8 +
  `@typescript-eslint/*` + `eslint-plugin-import`; lint is oxlint/prettier) — clears eslint@8 +
  `@humanwhocodes/*`. Bumped `@electron-forge/*` → 7.11.2, direct `glob` → 13 (off the vuln-flagged
  v11 in our own `codebase.ts`/`workspace-snapshots.ts`). Deprecation warnings **18 → 15**.
  - **Residual deprecations (upstream-blocked, all dev/build-time transitives — do NOT force-override:
    glob/rimraf majors switched callback→promise APIs and would break parents):** `glob@7/8/11` &
    `rimraf@2/3` & `inflight` (electron-forge installer chain + rimraf@6), `boolean` (global-agent/roarr),
    `@npmcli/move-file` & `gar` (cacache), `@esbuild-kit/*` (drizzle-kit ≤0.31 — only 1.0-beta drops it),
    `lodash.get`/`lodash.isequal`, `node-domexception`, `whatwg-encoding`. Revisit when upstream ships.
- **Verify remaining:** packaged-app smoke test (`npm run package` → approve a command with "Always
  allow") before release — owner-driven.

## ✅ Shipped in v14.13.3 (2026-07-18)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.3]`.

- **Auto-update fixed (mac + Linux AppImage).** Bundle `build/app-update.yml` via `extraResource` —
  electron-forge never generated it, so electron-updater hit an unhandled ENOENT at download time and
  stuck on "Downloading…". Plus updater hardening (manual `downloadUpdate().catch`,
  `disableDifferentialDownload`, unified deferred flow).
- **Auto-update fixed (Windows).** Squirrel.Windows ≠ electron-updater (NSIS-only) → switched Windows to
  Electron's built-in `autoUpdater` + `update-electron-app`/update.electronjs.org, wired to the same
  banner. Pure `chooseUpdaterKind()` selector + tests. CI now publishes the Squirrel `RELEASES` index.
- **⚠️ One-time manual update:** ≤14.13.2 installs can't auto-update to this fix — they need one manual
  install of v14.13.3, then auto-update self-heals. Windows auto-update pending real-device verification.

## ✅ Shipped in v14.13.2 (2026-07-18)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.2]`.

- **Core provider page shows real live model names** (Kimi/Qwen/DeepSeek/MiniMax) instead of
  `Core N` — `useAtlarixCoreCatalog` now derives from the working `useLanguageModelsByProviders`
  IPC (the `compass:get-tier-catalog` path resolved a different `compass_constants` instance than
  the override store is written to). Core badge → "Setup Complete".
- **Tier vocabulary retired from provider UI** — "Needs Setup" → "Add key", tier-free copy, and
  the Ollama/LM Studio 3-slot favorites picker collapsed to single-select.
- **Model-list perf** — `staleTime` on `useLanguageModelsByProviders`/`useLanguageModelsForProvider`
  so the 167-provider models.dev catalog stops rebuilding on every mount/focus.
- **Auto-update stuck-on-downloading fix** — removed the racy pre-feed deferred `checkForUpdates` +
  duplicate handler; `disableDifferentialDownload = true` (`src/main.ts`).

## ✅ Shipped in v14.13.1 (2026-07-18)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.1]`.

- **Markdown structure rule.** `<output_style>` now forbids multi-line code / line-breaking
  template literals inside table cells or inline backticks (GFM can't render them) — fixes
  phantom table rows and stray `{`/`}` in inline code (`src/prompts/system_prompt.ts`).
- **`<untrusted-data>` hidden in the UI.** New `stripUntrustedDataEnvelope()` strips the
  injection-defense envelope on the display path across all tool cards + previews; model-facing
  and persisted strings keep the wrapper.
- **Negative wallet balance explained.** Refund-clawback negative balance now shows a colored
  note to top up before using Core (`AtlarixCoreUsageCard.tsx`).

## ✅ Shipped in v14.13.0 (2026-07-17)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.13.0]`.

- **Co-author, not author.** Commits are authored by the user's own git config; Atlarix is credited via the
  `Co-authored-by:` trailer only. Terminal (`interceptor.ts`) + programmatic (`git_utils.ts`) paths inject the
  agent identity **only** as a fallback when git is unconfigured (`hasConfiguredGitIdentity()` probe).
- **Co-author toggle fixed.** `includeAtlarixCoAuthor` now gates the trailer on the terminal/prompt path too
  (`mode-prompt-bundle.ts`, threaded from `system_prompt.ts`); the `--author` instruction is gone.
- **Markdown replies.** `<output_style>` tells every model its user-visible replies render as GitHub-flavored
  markdown.
- **Security scope trimmed.** Dropped the four deferred "protect-user-from-their-own-agent" items (egress
  gating, sandbox read-confinement, env-var allowlist, automation allowlist-flip) — matching opencode / CC.
  Owner-protection + prompt-level untrusted-data defense unchanged.
- **Flaky test fixed.** Real-git worktree suites given the repo's 30s hook/test I/O budget.

## ✅ Shipped in v14.12.0 (2026-07-16)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.12.0]`.

- **Harness batch.** Wait-timer merge (stall snooze under `schedule_wakeup`, `\r` no-rearm, 180→300s,
  advisory reframed toward patience), live token counter (always-mounted composer hook + hold occupancy
  across turns), paste beachball/first-time-miss fix, image graceful-degrade (friendly "switch to a vision
  model" in onError, no allowlist), ask→explore case-tolerant skill match, errors-tab llmFallback deleted,
  `wake_on` nudge for backgrounded builds/tests/installs.
- **Model-picker real pricing.** models.dev cost merged into every provider's native fetch + OpenRouter's
  own per-token pricing parsed; PriceBadge shows real `$/M` (clipping fix included).
- **`edit_file` overhaul.** Multi-edit `edits` array (atomic) + Cursor-style `operation:"merge"` with
  `// ... existing code ...` markers (deterministic stitch, refuses-not-corrupts).
- **File reads align with opencode.** In-workspace files (incl. `.env`) read freely; workspace-boundary
  confinement (path-escape + new symlink realpath check) + run_command ask-gate kept.
- **Security.** Plaintext-keychain hardening (chmod 600 + banner + re-encrypt-on-recovery); privileged-IPC
  gating (`terminal:run`/execute-all-permissions origin-gate + zod).
- **Dropped/reverted:** OAuth PKCE (broke sign-in), outbound secret redaction, read-file secret-basename
  block — reverted to keep working behavior / match opencode.

## ✅ Shipped in v14.11.0 (2026-07-14)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.11.0]`.
Multi-repo (app + proxy + edge fns + Supabase migrations + launchpad); backend applied/deployed in prod.

- **Pricing reframe — Free + Pro + PAYG credits.** No tier bundles AI; Atlarix Core is pay-as-you-go
  prepaid credit on every tier. Team/`workforce` tier removed (connectors → Pro); Studio→Pro, Solo→Free.
- **Credit wallet + metering.** `credit_wallet` ledger + idempotent RPCs; proxy meters real OpenRouter
  cost +40% markup behind a **per-call cost reserve gate** (402 `insufficient_credit`) + 503
  `core_unavailable` + owner Discord alert. LS single credit product via `custom_price`; order webhook
  credits/claws back.
- **App.** Wallet UI (balance + additive top-up), automations gate (Free 2 / Pro 10), $1 trial credit,
  low-balance nudge, Team teardown, dead DB-Studio-legacy removed, avatar CSP fix, model-picker Core→"Paid".
- **vNEXT (`8d1e990`).** Voice-to-text (Whisper + BYOK cloud), live token counters, attachment dedup,
  image-gate removed, DB-closing guard, optimistic stop + mid-stream edit.
- **Launchpad.** Pricing → PAYG, Docs accuracy pass, Team pages removed.

## 🔜 Deferred / next

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI remain open (release-infra,
  no cert). OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in, reverted; the
  flow-in-progress gate stays).
- **Runtime-verify voice mic + DB shutdown-race** on a packaged build (voice confirmed working by owner
  2026-07-14; shutdown-guard committed, not stress-verified).

## ✅ Shipped in v14.10.0 (2026-07-12)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.10.0]`. Net **−362 lines**;
Owner-smoke-tested.

- **Command permissions rebuilt on the Codex sandbox + Claude Code ask model.** Deleted the hardcoded
  read/mutate/git command taxonomies that false-blocked valid commands (`git fetch`, `docker build`)
  in read-only modes. Enforcement = OS sandbox (read-only profile for Explore/Plan/Review; workspace-write
  for Build/Debug; native helpers gained `--read-only`); commands auto-run, only the danger gate +
  `.atlarix/permissions.json` rules prompt. CPU-throttle experiment stripped.
- **Accuracy prompt-skills** (`mode-prompt-bundle.ts`) — red-green ("a test must be red against the
  un-fixed code before it's trusted green"), test-connection ("assert the real code path, not a mock of
  the unit under test"), anti-flail ("switch verification approach after ~2–3 repeats"), reuse-before-build.
- **UI heat + streaming/virtualization overhaul** — react-virtuoso message virtualization (default-on,
  kill-switch), adaptive flush cadence, tail-bounded markdown re-parse, atom-fanout narrowing, one-time
  stale-index cleanup (~1.4 GB), grep/glob search labels. Calm/cool main process on large repos + long streams.
- **Fixes:** reconnect no longer shows a fake "user said continue" turn (out-of-band `<system-reminder>`
  continuation via new `continueInterrupted` flag); "Jump to latest" lands at the live generating edge
  (`align:"end"`). Dead task-ledger/completion-detector code removed.

## ✅ Recent shipped (detail in [`docs/CHANGELOG.md`](./CHANGELOG.md))

- **v14.9.1 (2026-07-10)** — bundled ripgrep via `@vscode/ripgrep` so `grep`/`glob` no longer need `rg`
  on PATH.
- **v14.9.0 (2026-07-10)** — retrieval teardown (fd-leak + heat root cause; −5,246 lines), opencode-parity
  multi-provider (full models.dev catalog), per-sub-agent token badge. **Post-release owner actions
  (done):** rotated OpenRouter master + app Supabase service-role keys; cleaned GH Actions vars.

## 🔐 Security follow-ups (from `docs/SECURITY_REVIEW_v14.8.12.md`, owner-triaged)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF +
pro-return confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP
description wrapping + OAuth-URL validation, the **universal write-confining sandbox**
(Win AppContainer + Linux Landlock bundled), and the **system-scope approval gate** (which
also closed M1 — cwd `allowedRoots` widening is now gated on interactive approval).
**Deferred (tracked):**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (code-signing certs + `app-update.yml` for NsisUpdater; out-of-band
  signature for AppImage), not app code. Owner chose NOT to gate the public release on it.
  (Windows helper sign step is already wired — set the cert secret to enable.)
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS; they
  build (non-blocking) in the first Windows/Linux CI job — watch those `cargo build` steps and
  budget one small fix-up iteration if the Linux `landlock` 0.4 API drifted.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the
  denylist taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL
  allowlist permits a query param (current gate = flow-must-be-in-progress).
- Sandbox **read**-confinement, model-context **secret redaction**, **egress** gating, and the
  remaining Medium items (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

## ✅ Shipped in v14.8.13 (2026-07-07)

Full detail in [`docs/CHANGELOG.md`](./CHANGELOG.md) `[14.8.13]`.

- **Universal sandbox + system-scope gate + done-responding notification (2026-07-07).** Bundled
  Windows AppContainer + Linux Landlock write-confining helpers (macOS Seatbelt already built-in;
  non-blocking CI, sign-ready); the system-scope approval gate (distinct "System change" prompt,
  runs approved installs unsandboxed, closes M1); the OS notification now also fires when a turn
  finishes responding (unfocused). Native helpers validate in Windows/Linux CI.
- **Harness + security + feature pass (2026-07-07).** Shift+Tab global, streaming scroll-lock,
  attachment vision cold-cache, indefinite MCP auth waits, terminal mode-block message; the
  security fixes above; notification sound (+ unfocused OS notification); prompt refinement
  (harvest + Debug reasoning_extraction reframe + read-only branch-nav). B4 (bg-command "done"
  while running) confirmed a model-behavior quirk — harness re-injects the exit result via
  auto-wake; mitigated by the prompt lines.

- **Native-git reads + Code-tab removal + universal language (2026-07-06).** Local git ops are
  native-git-only (production Sentry `null.slice` fix; `enableNativeGit` deleted); Code tab + Monaco +
  QuickFileOpen deleted; ctags allowlist → auto-detect + 2 MB guard (ctags-only blueprint, no null
  cliff); ast-grep / blast-radius / dead-blueprint-chain pruned (−7851 lines, watcher →
  `search-index-watcher.ts`).
- **Automations SHIPPED (2026-07-06).** Migration 0066; cron (node-cron) + GitHub-poll + MCP-poll
  triggers (deterministic, no LLM in loops); unattended runs via the headless spine (dangerous always
  denied, 10-min budget, concurrency 1); read-only default + opt-in worktree-write proposals; triage
  feed tab.
- **`chat_stream_handlers.ts` decomposition COMPLETE (2026-07-07).** God-file **7984 → 2364 lines
  (−70%)**; `runStream` is now a thin orchestrator over 8 `chat_stream/turn-runner/*.ts` modules
  (simple-stream-text, round-retry, response-chunk-update, context-assembly, ask-branch, build-branch,
  finalize, prompt-bundle). Every extraction body-verbatim + separately gated (ts + oxlint +
  per-project agent-evals 73 / node 1484 / renderer 58). **Smoke focus:** the context-overflow →
  `handleTurnError` rerun recursion path is NOT eval-covered — force a mid-turn overflow-compaction retry.

---

## Open follow-ups

- **DB shutdown race — `TypeError: The database connection is not open`** (Sentry, seen on 14.9.1,
  still present in 14.10.0; **benign** — `handled`, fires only during app quit, no in-session impact,
  worst case one dropped pending write). Cause: the SQLite handle is closed (`db/index.ts:65`
  `sqlite.close()` / `app_handlers.ts:1185` `db.$client.close()`) while `main.ts:1437` `before-quit`'s
  async flush/session chain still has a drizzle query in flight → straggler `.prepare()` throws. Fix
  (target 14.10.1): a `closing`/`isClosed` guard so `db` calls short-circuit once shutdown starts
  (robust vs. `void`-ed late writers), or reorder to `await` the flush chain before `db.$client.close()`.
  ~15-min change + a test; own fresh plan-mode session.
- **DONE in v14.8.12:** approval-wait audit (MCP auth waits now indefinite + Stop-cancellable),
  Shift+Tab global, attachment vision cold-cache, notification sound. **B4 (bg-command "done" while
  running)** resolved as model behavior — the harness DOES re-inject the exit result via auto-wake
  (`recordBackgroundCommandResult`); mitigated by the new prompt lines (ground-claims / finish-the-turn).
- **CONSIDER (evaluated → CLOSED): `browser-use`.** Not adopted — Python/Playwright (bad Electron fit),
  it's its own agent loop, and its one good idea (stable element refs) Atlarix already has via
  `browser_inspect` snapshot `ref`s. No capability gap. [[atlarix-preview-webcontentsview]]
- Small / carried: `.gitignore`-render profiler (v14.8.10 §3.4); Atlarix GitHub account for contributor
  credit (owner action; code done); user-message multimodal parts for HISTORICAL turns (current/edited
  turns embed since v14.8.11; history round-trips via read_attachment).
- **Dependency deprecation triage (own session).** Scoped, not a blanket "zero warnings" chase
  (@ai-sdk/anthropic MUST stay 2.x w/ ai@5 [[atlarix-ai-sdk-version-trap]]; zod mid-v4; 3 patch-package
  patches; ABI-pinned better-sqlite3/node-pty/keytar). Worklist = `npm outdated` (direct) + `npm audit`
  + own deprecated-API usage + CI action EOLs; leave pinned/transitive with a note.

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the existing
  `@atlarix review` GitHub bot: mention it, it picks up the task, works in a real Atlarix workspace,
  and posts the PR/result back (near-zero switching cost, big reach; how Devin / Copilot-in-Slack win).
  (b) A **shared, observable agent session** — a "war room" where several teammates watch one Atlarix
  run live, drop steering comments, approve actions, and hand off — tied to the Workforce tier. The
  chat shell is not the differentiator; the shared *agent* session is. Far-off; capture, don't build yet.

> Open work + the current release only. **Full shipped-version history lives in
> [`docs/CHANGELOG.md`](./CHANGELOG.md)** (and `docs/CHANGELOG_PREVIOUS.md`).
