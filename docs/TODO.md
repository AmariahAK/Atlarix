# Atlarix TODO

**Current version:** v14.38.0 — **RELEASED 2026-08-27** (12 assets, `/releases/latest` verified,
draft=false, headless green, release body carries the changelog prose). One home for every sentence the app says
about money, the allowance-vs-credit split surfaced (the data was already there and being thrown
away three times), the refund path the subscription wallet shipped without, browser tools that work
against localhost with the right panel closed, and a small what's-new panel fed from
`atlarix-releases/updates.json`.
**Previous:** v14.37.0 — RELEASED 2026-08-24. Deep thinking on Atlarix Core (and on the
wire for every OpenAI-compatible provider), lines-written stats per workspace with a contribution
calendar, web-search query fidelity, tool cards that keep their own results, and a mode chip that
stops contradicting itself.
**Previous:** v14.36.0 — RELEASED 2026-08-22. Diagnostics panel + `--doctor`, the
database dead-end, per-session work mode, cold-chat eviction, debug routed like build, the memory
location at the top of the prompt, three missing preload channels, and the dead
`write_multiple_files` cluster removed.
**Previous:** v14.35.0 — RELEASED 2026-08-20 (12 assets, `/releases/latest` verified).
Electron 43, browser-backed web search, the
spec-line majors, 54 → 28 advisories, the Dyad-era removal (~30,500 lines), plan switcher +
plan-by-title, automations returning their id, the ban system, the whisper-worker CSP, and four
plan-tracking fixes.
**Last updated:** 2026-08-27

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative → [`CHANGELOG.md`](./CHANGELOG.md). Design prose →
> [`DESIGN_NOTES.md`](./DESIGN_NOTES.md). Operational SQL and steps → the runbooks
> ([`BAN_RUNBOOK.md`](./BAN_RUNBOOK.md), [`MSIX_RUNBOOK.md`](./MSIX_RUNBOOK.md)).
>
> **Refined 2026-08-20.** This file had reached 1,135 lines, 46% of it v14.35.0 release narrative
> that belongs in the changelog. Every open item and every trap survived the cut, compressed to its
> operative sentence; `git log -- docs/TODO.md` has every word of the long form. The failure mode
> being corrected is a queue that reads three times its real size, so genuinely open work hides
> inside finished work. Previously trimmed 2026-08-11 and 2026-08-15.

---

## 🧾 Staged for the next release — the bar says a percentage

### The dollar figure was the bug, not the arithmetic

- **The meter shipped reading "$0.42 of $1,000,000.00 used", and `billing_copy.ts` forbids exactly
  that.** The rule at the top of that module — never publish the allowance in dollars, because
  denominating it prices our own cost structure and invites the "$19 for $10" comparison — was
  written in the same version that broke it, in the first thing that rendered the number. A share of
  the whole says the same thing to a customer and nothing to a competitor.
- **`<1% used`, never `0% used`, once anything has been spent.** Rounding real usage down to zero
  tells someone their metered account is not being metered, and a comped account sits precisely
  there.
- **The fill has a visible minimum (1.5%) and the track has a border.** At 0.00004% the fill was
  sub-pixel, so the bar read as an untouched meter — a different statement from barely touched — and
  without a border it did not read as a bar at all.
- **The headline is PURCHASED CREDIT, both surfaces.** The spendable total merges money that never
  expires with an allowance that resets, and the sum answers nothing: the allowance is spent first,
  so purchased credit is exactly what is left once it runs out. Falls back to the total when a
  deployment reports no split — "$0.00" on an account with a balance is worse than a broad number.

### The account page splits what CAN be split, and refuses the rest

- **`get_credit_breakdown`** (`20260827160000_credit_breakdown.sql`), a SECOND RPC rather than more
  keys on `get_credit_balance` — that one is on the proxy's hot path before every request and must
  stay one cheap row. This one runs when a human opens the page. **Applied and verified live.**
- **Per-product ALLOWANCE is real; per-product CREDIT is not, and the difference is load-bearing.**
  `credit_grants` is one row per (user, product), so "Atlarix Reviewer · 30% used" describes a row
  that exists. `credit_wallet` is a SINGLE shared balance and `spend_from_wallet` deliberately lets
  one product's allowance pay for the other — so splitting the headline per product would claim a
  boundary the wallet does not have. A lie with money attached.
- **So the per-product number is SPEND.** Every debit already carries a `source` written at the point
  it happens, which makes "Atlarix Reviewer: $1.24" recorded fact rather than a derived guess, and it
  answers the actual question: which product is consuming the money.
- **Fails soft to `unavailable`.** A deployment without the RPC renders the page it rendered
  yesterday rather than an error. Launchpad pushed 2026-08-27.

---

## 🚀 Shipped in v14.38.0 (2026-08-27)

### The usage bar: consumption, not composition — added after the packaged pass

- **Reported from the packaged build.** The bar drew the allowance beside the purchased credit —
  the COMPOSITION of what is left — which rendered as "$999,999.73 included / $1,000,000.67 credit"
  and answered nothing. A bar implies consumption whatever you put in it.
- **Consumption is not derivable from a balance**, so this started in Postgres.
  `credit_grants.total_cents` records what the period GRANTED; `cents` keeps meaning what is left;
  consumed is the difference. `20260827140000_grant_period_total.sql`.
- **The invariant `total_cents >= cents` is what makes the subtraction safe**, and the refund path
  is where it nearly broke: reducing the total by the amount REQUESTED rather than the amount TAKEN
  turns a 50% refund of an 80%-spent period into "$8.00 of $5.00 used". Reducing both by `taken`
  also leaves consumed unchanged, which is the truth — a refund does not un-spend anything.
  **Verified against the live database inside a rollback**, all four write paths.
- **Backfilled from the LEDGER, not from `cents`.** The easy default claims every existing
  subscriber consumed nothing — wrong on every account that has spent anything, including the one
  this was reported from ($1,000,000.00 granted vs $999,999.73 left, recovered correctly).
- **Additive at the RPC.** `balance_cents` / `granted_cents` / `purchased_cents` keep their exact
  meanings, and both money paths that read this row (`atlarix-proxy/src/entitlement.ts`,
  `atlarix-reviewer/src/jobs/queue.ts`) parse it through a plain cast with no runtime validator and
  touch only `balance_cents`. Checked in both services rather than assumed.
- **First test anywhere that constructs a balance row with the split.** Every existing mock was
  two-key `{ok, balance_cents}` asserting only `balanceCents` — precisely how the handler came to
  drop `granted_cents` silently, twice.


> The customer-facing half of the pricing change, which shipped its backend on 2026-08-26 and none
> of its front. Plus two unrelated defects that were cheap while the same files were open.

### Refunds — the money path the subscription wallet shipped without

- **Nothing handled a subscription refund at all.** `order_refunded` bails on
  `if (kind !== 'credit')` and `subscription_payment_refunded` had no case, so it hit `default:` and
  was 200-ACKed in silence. Refunding a Pro month left the tier active AND left the allowance in the
  wallet. The four policy decisions are recorded in the pricing section below; the shape follows
  from them.
- **A refund of a FEE is not a refund of CREDIT, and conflating them moves the wrong money.** $19
  bought entitlement plus an allowance, not $19 of credit — so a subscription refund claws back the
  GRANT (proportionally to the refunded fraction of the invoice, floored at what is left) and never
  touches purchased credit. A top-up refund does the opposite: it claws back exactly
  `refunded_amount` from purchased credit, and is ALLOWED to drive it negative.
- **`refunded_amount`, not `subtotal`.** LemonSqueezy supports partial refunds and `subtotal` is what
  the order was WORTH; reading it clawed back $50 on a $10 refund. `subtotal` survives as the
  fallback because it is right for a full refund and an older payload may not carry the newer field.
- **`credit_transactions.kind` is CHECK-constrained**, so `grant_refund` needed the constraint
  widened or the insert would raise 23514 on a path whose whole job is to move money back quietly.
  Same trap as `review_history.kind` on 2026-08-26. `credit_grants.cents` additionally carries
  `CHECK (cents >= 0)`, so the floor at zero is enforced by the schema as well as by policy.
- **A refund RESOLVES THE ACCOUNT FROM THE SUBSCRIPTION ROW ONLY** — no `custom_data` fallback,
  unlike `subscription_payment_success`. The asymmetry is deliberate: granting to the wrong account
  on a bad guess costs us a month's allowance, while taking from the wrong account costs a customer
  theirs.
- **The pure half is now testable.** `supabase/functions/_shared/refund-math.ts` holds the product
  classification, the refund fraction and — the reason it exists — `invoiceIds`, because on a
  payment/refund event `data.id` is the INVOICE and the subscription is
  `attributes.subscription_id`. Reading the wrong one does not throw; it silently addresses a
  subscription that does not exist and logs "unknown subscription" for a customer who is very much
  known. 21 tests, verified sensitive by mutation.
- **STILL OWED, and it gates the whole thing: `subscription_payment_refunded` must be ticked in the
  LemonSqueezy webhook settings.** If it is not subscribed the branch never fires no matter what is
  written — exactly how the `subscription_payment_success` gap survived. Apply
  `20260827120000_refund_paths.sql` BEFORE deploying the function, or the branch calls an RPC that
  does not exist.

### The app stops talking like Pro gates AI

- **One module, five call sites.** `src/shared/billing_copy.ts`; the copy moved out of
  `ipc/shared/compass_constants.ts`, which reads env vars and resolves tier ids — so every renderer
  that wanted one sentence was importing the Core routing table across a layer boundary.
- **The markers are now IMPORTED, not re-declared.** `ChatErrorBox` decided which buttons to show by
  searching the streamed error for a substring it typed out itself, so rewording the copy silently
  deleted the "Top up credit" button from the error that most needs it. A test asserts each marker
  is genuinely present in the message it claims to match, end to end through the classifier.
- **A third party's free-tier error was selling Atlarix Pro.** Wrong twice: buying Pro does nothing
  about Google's quota, and Pro does not gate AI. Now offers Core or another model.
- **Nothing about a balance names a tier.** A 402 means the SPENDABLE total is zero — both halves
  gone — so there is no distinction left to draw, and naming Pro would tell a Free user about an
  allowance they never had. A test asserts no message about money says "upgrade".
- **The allowance is never published in dollars**, asserted by test. Denominating it prices our own
  cost structure and invites the "$19 for $10" comparison.

### The allowance split, which the app already had and discarded

- `get_credit_balance` has returned `granted_cents` and `purchased_cents` since 2026-08-26 and
  **three separate call sites cast them away** — `auth_handlers.ts`, `useCreditBalance` and
  `doctor.ts`. So the one number the app could not show was which half of a balance expires. Pure
  client change; no migration, no new channel.
- **Two sub-numbers, NOT per product** — identical to the web account card and for its reason:
  `spend_from_wallet` deliberately spills allowances across products, so "Reviewer allowance: $10" is
  not a statement about what reviews can consume. What is true, and what the reader needs, is which
  part expires.
- **Null is not zero.** An older server that returns only a total renders as "no split known" rather
  than as an empty allowance, which is a different and alarming claim.
- `--doctor` now reports the split too, because the two fail for different reasons: an allowance at
  zero on a paid plan mid-period is a grant that did not renew, and that looks identical to an empty
  wallet if you only print the total.
- **A second nudge at the moment the month's usage runs out** — the balance changes character there,
  from something that resets to money the user paid, and it is the only reason the halves are tracked
  separately at all.

### Browser tools against a localhost dev server — the guard existed and never ran

- **Reported as: pointing the agent at localhost did nothing until the right panel was opened by
  hand.** The URL was never the problem — `browser.ts` passes `allowLoopback: true` explicitly.
- **`setActiveTab` and `setVisible` only attached the `WebContentsView` when `scope.visible`.** With
  the panel shut the view was created and navigated but never attached to a window, and an unattached
  view has no layout viewport: the document lays out at zero width and every geometry answer is
  plausible and wrong.
- **`fallbackBounds` was written for exactly this** — its docblock describes the 0x0 layout viewport
  — but it was only applied on the attach path, so it could not run on the one path it existed for.
- **Now always attached and always sized; `View.setVisible` decides whether it is DRAWN.** That keeps
  the reason the conditional existed (a drawn view with no React chrome is a bare browser slab over
  half the app) and drops the consequence nobody wanted. `requestBrowserPanel`'s docblock claimed
  "the browser tools work fine with the panel shut"; that claim is now true.
- **`backgroundThrottling: false` on the tab**, which was missing and is a second cause regardless:
  Chromium throttles hidden pages hard, and an SPA that finishes hydrating in a rAF callback would
  never finish. 6 regression tests, all 6 confirmed failing against the old code.

### A what's-new panel, fed from atlarix-releases

- **Fetched, not bundled** — a note shipped inside a release only reaches people who have already
  updated, which is backwards for telling somebody an update exists. `updates.json` sits beside
  `core-models.json` and copies that fetcher wholesale, including the `?t=` cache-bust (the raw
  CDN serves a stale body for minutes) and the never-throws contract.
- **No bundled fallback, unlike core-models**, because a missing model map breaks dispatch and a
  missing note breaks nothing. **An empty panel is worse than no panel**: a blank card with a close
  button reads as a bug.
- **Dismissal is keyed on the ENTRY ID, not the app version**, so editing a note's text does not
  resurface it and a new note does. `UpdateBanner`'s
  `atlarix_update_banner_dismissed_${version}` is the precedent.
- **The link is validated as https in MAIN**, not at the click — the renderer would otherwise hand an
  arbitrary string from a remote JSON to `openExternalUrl` on a user gesture.
- Deliberately not the update banner: that says a NEWER version exists, this says something about the
  version you are running. They can co-exist, and `update-helpers.ts` documents that this codebase has
  been bitten once by two update surfaces firing together.

---

## 🚀 Shipped in v14.37.0 (2026-08-24)

> Five batches in one release: the Core Deep-thinking bug the owner reported (which turned out to be
> inert on EVERY OpenAI-compatible provider, not just Core), the lines-written card and its
> contribution calendar, web-search query fidelity, tool cards that stop showing each other's
> results, and a work-mode chip that stops contradicting itself. Sub-sections below are in the order
> they were built; each keeps its own traps.

### A contribution calendar for code changes

> The GitHub contribution-graph equivalent for the profile card, on the owner's ask. Cheap because
> `edit_stats` already stores one row per day: the whole data layer is one `GROUP BY day`, no
> migration, no new IPC channel, no change to the recording path.

- **Built now rather than later, deliberately.** There is no backfill, so history starts the day it
  ships — every week of delay is a week the graph can never show.
- **Quantile buckets, not linear.** Lines changed is long-tailed and a linear scale fails SILENTLY:
  it renders, it just says nothing. Verified against seeded realistic data (min 8 / median 50 / max
  6,719 — an 840× range): quartiles spread the days **20/22/18/19** across the four shades, where
  quartering the RANGE would have put 78 of 79 days in level 1. A test pins that comparison directly
  so the scale cannot regress to linear unnoticed.
  Cuts are taken over **non-zero** days only (a day with no work is not a small amount of work, and
  including zeros drags every cut toward zero) and deduped, because on a short history naive quartiles
  land on top of each other and silently create empty levels.
- **Any day with activity is at least level 1.** Level 0 is reserved for "nothing happened" — letting
  a real if small day render as an empty square would make the graph lie about the one thing it exists
  to show. Future days in the current week are blank rather than level 0, for the same reason.
- **The window grows instead of starting empty.** From the first recorded day to today, floored at 8
  weeks and capped at 53. A fixed year-wide grid on day one is ~360 blank squares and one green
  one — that reads as broken, not new. Below 7 recorded days the calendar does not render at all and
  the card is exactly what it was.
- **The ramp is measured, not eyeballed.** Sequential = one hue, monotone lightness, **anchor flipped
  in dark** (a dark mode derived by inverting the light ramp lands the low end invisibly on the card).
  Measured OKLab L, strictly monotonic both ways: light `0.937→0.432`, dark `0.298→0.845`. The two
  steps nearest each surface fall under 3:1, which is what a sequential heatmap is FOR — the low end
  recedes — and the relief that obliges is the per-cell tooltip plus `aria-label`, both generated by
  ONE `describeCalendarCell` so the visible text and the screen-reader text cannot drift.
  (The palette validator's six checks are scoped to categorical palettes — its own output says so and
  directs a sequential ramp to lightness monotonicity, which is what was checked.)
- **No charting dependency.** Squares and a colour scale; a chart library here would be surface with
  no capability behind it. **One shared tooltip** positioned from the hovered cell rather than ~370
  Radix roots, each of which mounts its own provider.
- **Inherits the counter's blind spot, and says so.** Changes made by commands the agent runs are not
  counted, so a codegen- or formatter-heavy day looks paler than it was. The card's existing footnote
  covers the calendar too.
- **Attribution follows what DISPATCHED, not what was selected** — found while checking the owner's
  first real card. When the selected provider has no usable key, `getModelClient` falls back to
  Atlarix Core and rewrites the model INTERNALLY, leaving `effectiveModel` naming the original choice
  (the same quirk already documented on `resolveDispatchCapabilityProviderId`). The stats read the
  selection, so those turns would have filed **Core's work under the user's own key** — the one
  distinction the card exists to draw. Now taken from the model client
  (`builtinProviderId` + `model.modelId`, already the `vendor/model` wire form, so no tier resolution
  and nothing to go stale). The owner's logs had 3 such fallback turns. NOT the cause of the
  `(deepseek)` label on his card — that was verified correct from the dispatch log
  (`wire=deepseek`, key supplied by env var rather than the `provider_api_keys` table).

- **Not built:** the year selector (nothing behind this year to select), a per-workspace filter
  (GitHub's graph spans all repositories, so all-workspaces is the faithful analogue — and the
  per-workspace rows are right there), and the `edits`-vs-lines toggle (data is stored, so it stays a
  small change if wanted).

### Web search fidelity, crossed tool cards, an honest mode chip

> Three defects, all found from ONE real session (`wisdom-drop`, 2026-08-24) and all confirmed
> against that session's search log rather than reasoned about. The agent's own words started it:
> *"The deep searches returned mostly SEO/site content, not clean quotable candidates."*

- **The query never reached the engine as written.** `optimizeQuery` lowercased, stripped stopwords,
  dropped words ≤2 chars and **truncated to six keywords** — for EVERY search, including exact-phrase
  lookups, and straight through quoted spans. Measured from the log:
  `"The mystery of human existence lies not in just staying alive…" Dostoevsky Brothers Karamazov`
  went out as `"the mystery human existence lies not` — phrase shredded, author dropped, and a
  **dangling unclosed quote**. Brave returned nothing. It is a keyword heuristic built for error
  strings, applied to prose. **The general web now gets the RAW query**; the reduction is kept for the
  site-scoped searchers (SO/GitHub/MDN/Reddit) and is now quote-aware, with quoted spans exempt from
  the six-keyword budget so a quote plus its author cannot push the author out. If the raw query finds
  nothing, it retries ONCE with the keywords — the heuristic's real value (rescuing a chatty question)
  kept, at a cost paid only by a search that already failed.
- **Deep search was hardwired to a developer source mix.** `runDeepSearch` passed `"all"` while quick
  defaults to `"general"`, and under `"all"` the priority table ranked
  `stackoverflow 5 … general 1` — the open web LAST — then `slice(0, 3)` kept only the top few. So
  every deep search on a non-code topic returned StackOverflow/MDN/GitHub. **`all` and unspecified now
  both mean general-first**; developer sources outrank the web only when the caller names them. Deep
  is a depth setting, not a statement about subject matter.
- **A double filter that culled to zero.** `filterRelevantResults` scores against the FULL original
  query at >0.25 token overlap — but the results were found by the *mangled* query, so genuine hits
  routinely failed the bar and a search with 25 hits returned 0 sources. That is where "0 results" and
  bare "Done" cards came from. **It now falls back to the ranked list when the bar rejects everything:
  a search that found pages may not report none.**
- **Parallel tool cards showed each other's results.** The Berry card read "0 results" while the
  Dostoevsky card displayed Berry's results. The log proves both searches were correct
  (`"the impeded stream one that sings"` → 19; `"the mystery human existence lies not"` → none) and
  the model received them correctly — **the damage was display-only, which is the worse place for it**:
  the transcript then contradicts what the agent says it found. Cause: the card was matched by
  `toolCallId` but its CONTENT fetched by tool NAME, scanning last→first, so the last call to finish
  supplied the body for every card of that name. Now keyed on the call id
  (`lib/chat/find-tool-activity-result.ts`, pulled out pure so the pairing is testable); the name scan
  survives only for rows that have no call id.
- **An empty search says which query came up empty** instead of "Done" — `buildWebSearchResultsView`
  returned null on empty `sources` and fell to the generic tail. Only an explicit empty array counts,
  so an unrecognised envelope is not mislabelled as an empty search.
- **The mode chip contradicted itself.** Footer read `Debug · wisdom-drop` beside a `Build` button.
  Root cause was NOT the mid-turn switch: `ChatInputControls` resolved the mode from the GLOBAL
  preference alone — never updated when sessions gained their own mode in v14.36.0 — so a session
  whose mode differs from the global showed the wrong one even when idle. **Both now share
  `resolveSelectedWorkMode`**; having two copies of the rule is what let them drift.
  **A running turn keeps its mode** (owner's call; reversing that re-opens the v14.36.0 bug where
  another window's picker revoked a live turn's write permission), so while a turn streams the footer
  names the mode the TURN is running in and the picker tags the new choice `· next turn`. Both
  statements true at once. The dispatched mode is remembered in `turnWorkModeByChatIdAtom`, written at
  dispatch and read only while streaming — so no stream-end site can be missed and leak a stale value.
- **Shift+Tab was a no-op with a toast** — found by the owner immediately after the chip fix, and NOT
  merely cosmetic. The chord read the GLOBAL preference and wrote only the global, while the picker
  reads `session ?? global` and writes both. Since a turn dispatches with
  `workModeOverride ?? sessionWorkMode`, in any session with a stored mode the cycle started from the
  wrong mode AND the next turn still ran in the old one — the toast said "Mode: Explore" while the
  turn stayed Build. The footer previously read the global too, which is the only reason the chord
  ever *looked* like it worked. **Third copy of the same rule, so the rule now has one home:**
  `useWorkModeSelection` (read + write) used by the picker and the chord, over
  `resolveSelectedWorkMode`. `settingsPatchForWorkMode` — the global-only write — is no longer reached
  from either control, and a test asserts that structurally. Also added `workMode` to the shortcut
  effect's deps (the handler closes over it) and memoised the setter so a global key listener is not
  rebound every render.
- **Web search confirmed better by the owner** on a real turn after the fix.
- **Not doing (owner's call): the proxy price-override for models models.dev has not listed.** Checked
  today: `zai` still tops out at `glm-5.2`; `glm-5.3` exists only under `zai-coding-plan` /
  `zhipuai-coding-plan` (cost 0 — subscription rows) and third-party gateways. The proxy prices from
  models.dev keyed `provider/model`, so pointing Core at `zai/glm-5.3` would bill the flat reserve.
  Staying on 5.2 costs nothing; revisit when the catalog lists it.

### Deep thinking on Core, and lines written per workspace

> Two items, one session. The first is a bug the owner reported (no Deep-thinking toggle on Atlarix
> Core, present on BYOK for the same model); the second is a new profile-page card. Full test suite
> green; the packaged app still owes a by-hand pass (below).

- **Deep thinking was missing on Core and INERT on every OpenAI-compatible BYOK provider.** One root
  cause with three faces, all of it **capability state that lives in main being read from the
  renderer**. `ChatConfigDropdown` called `isReasoningCapableModel` directly, but both of that
  function's inputs are main-process module state: the models.dev reasoning registry
  (`registerModelsDevReasoning` is only ever called from `models_dev.ts`, which imports `node:fs` +
  `electron`) and the Core tier→vendor routing map (`core-model-overrides.ts`, likewise main-only,
  with a build-time env fallback Vite defines for the main bundle alone). **In the renderer both were
  permanently empty for EVERY model** — so the per-model catalog gate that
  `model-reasoning-profile.ts` was written for never ran in the UI at all, and everything fell
  through to the legacy `PROVIDERS_THAT_SUPPORT_THINKING` allowlist. BYOK DeepSeek matched
  `deepseek` there and showed a toggle; Core is the synthetic `compass`, which no allowlist names,
  so the whole lineup showed nothing. Same fallback wrongly showed the toggle for `deepseek-chat`
  (does not reason) and MiniMax-M2.7 (declares no control).
  **Fixed by answering in main and shipping the answer**: `getLanguageModelsByProviders` stamps
  `supportsDeepThinking` onto each model row and the dropdown reads it — no new IPC channel, and the
  query is already invalidated on `core-models:changed`, so a lineup change updates the toggle with
  no extra wiring. Deliberately that payload and not `compass:get-tier-catalog`: per
  `atlarix-core-catalog.ts:128` the packaged main bundle resolves Core ids through a DIFFERENT
  module instance for the tier-catalog builder, and the language-models path is the one documented
  as resolving them correctly.
- **Nothing ever reached the wire, either.** `resolveReasoningRequest` has always resolved the right
  per-model control, but its output was only ever read as a boolean "can this model reason" —
  `getExtraProviderOptions` had exactly ONE call site, the probe inside
  `hasNativeDeepThinkingSupport`. So the toggle moved nothing for Core or for any open-weight BYOK
  provider; those models only ever reasoned by their own default. Now merged into
  `providerOptions[<wire provider>]` in `simple-stream-text.ts`, which is the bucket
  `createOpenAICompatible({ name })` reads.
  **TRAP, and it is silent: the effort key must be camelCase `reasoningEffort`.** The SDK spreads the
  provider bucket into the body and THEN writes
  `reasoning_effort: compatibleOptions.reasoningEffort ?? undefined` over the top — so a snake_case
  key we supply is overwritten with `undefined` and dropped by `JSON.stringify`. It looks correct in
  every unit test that asserts the resolver and sends nothing. `reasoning-on-the-wire.eval.test.ts`
  asserts the actual request body for exactly this reason.
  Second trap: the SDK deprecates the raw bucket name whenever it differs from its camelCase form —
  irrelevant for `compass`/`deepseek`/`qwen`, but a user's custom provider is commonly `my-proxy`.
- **`compass` is a WIRE id, not a vendor — and the reasoning stack conflated them.** New rule, stated
  in the code: **dispatch keys off the wire provider; capability keys off the vendor**
  (`resolveDispatchCapabilityProviderId`). `detectReasoningCapability` deliberately keeps the WIRE
  provider — it classifies which request SHAPE a route accepts, not who serves the model, and that
  is what still routes an OpenRouter-backed Core tier to the `reasoning` object while a direct-routed
  one gets `reasoning_effort`. The tier's catalog id encodes the difference by itself (slashed =
  OpenRouter, bare = direct), so no branch was needed. `deriveReasoningCeiling` now keys on the
  vendor, which also means Deep ON on Core finally asks for the model's real maximum instead of one
  notch below it.
- **Known limit, by design:** a Core model absent from models.dev falls back to the vendor heuristic,
  and if that vendor is not a known thinking provider it shows no toggle. **This is reachable** — see
  GLM-5.3 on the `zai` row in [[atlarix-v14-36-0-release]]. The dispatch log line now prints the
  resolved vendor, catalog hit/miss and control kind so the three causes of a hidden toggle are
  distinguishable from a user report. If it bites, the fix is a reasoning hint per tier in
  `core-models.json`; not built.
- **New: lines added/removed per workspace + most-used model** (profile page). Recorded in
  `PermissionInterceptor.executeOperation`, the single funnel EVERY accepted write passes through
  (user-approved, silently auto-approved, per-hunk, sub-agent, ask-branch) — counting at the tool
  would have missed most of them. Counts come from `computeDiffHunks`, the same LCS the approval card
  draws, and read `preview.content` AFTER the per-hunk override, so a partial acceptance counts what
  landed. `edit_stats` is a daily ROLLUP keyed (workspace, day, provider, model): counts are gross by
  the owner's decision, so it only accumulates, and the table stays bounded with no pruning job.
  **`provider` is load-bearing** — `compass` vs `deepseek` is the only thing separating the same
  model reached through Core from the same model on the user's own key, which is the distinction the
  card exists to draw. The model id is stored RESOLVED, never `core-N`, or repointing a tier would
  silently relabel history.
- **Honest by label:** commands the agent runs (`sed -i`, codegen, a formatter) change files without
  passing the write gate, so they are not counted and the card says so.
- **Adjacent, fixed while verifying:** `core-model-override-store.ts` was imported by its
  `@/ipc/shared/...` alias from one caller and relatively from the other — the exact alias-vs-relative
  split that duplicated a singleton in v14.13.2. Had the bundler ever split it, `setCoreModelRouting`
  would write one copy while `getCoreTierRouting` read the other and every Core tier would resolve to
  nothing. Normalised to the alias, with the rule stated on the module. **It was NOT split in the
  current build** — `compass_constants` appears exactly once in the packaged main bundle (verified
  against its `EMPTY_SLOT_SENTINELS` literal), and shipped builds resolve Core models at all, which
  they could not if the store were duplicated.
- **Noticed while running `--doctor` on the packaged app, NOT fixed:** the `atlarix-core` probe
  reports `timed out after 12000ms` but the row is billed at **135,973ms** — the timeout is not
  actually bounding the probe, it only labels the failure. Worth a look; unrelated to this batch.
- **Owed:** a by-hand pass in the PACKAGED app — the Core toggle, and the `(Atlarix Core)` label on
  the card — plus one real Core turn confirming the vendor accepts the reasoning shape without a 400.
  Also unresolved and deliberate: `account-settings.tsx:34` redirects to `/sign-in`, so a signed-out
  BYOK-only user cannot see stats that are entirely local to their machine. The card is
  self-contained; mounting it on `/settings` is a one-line change if that is wanted.

## 🚀 Shipped in v14.36.0 (2026-08-22)

> One batch: the Skills paywall fix, three defects and two decisions from reading the latest
> `claude-code` / `opencode` / `codex` tags against our own source, the Diagnostics panel, and — added
> last, on the owner's call — debug routed like build. The packaged app was exercised by hand before
> tagging. Still owed: the session-load diagnostic numbers (below).

> **Not doing: a UNC/non-local path guard on the file tools.** Built 2026-08-21 and removed the same
> day on the owner's call. The finding was real — `read_file` auto-allows any absolute path with no
> approval card, and `path.isAbsolute` is **true** for `\\host\share\x` on Windows, so an injected
> read of `\\attacker.example\share\x` makes Windows authenticate outbound over SMB and hand over the
> machine's NTLM hash. What it is NOT is complete: `run_command` can still `type \\host\share\x`,
> network is on in every mode, and closing that needs the sandbox — which on Windows is Low IL,
> `NO_WRITE_UP`, so reads up are permitted by design. **Weighed against:** Windows-only, needs an
> attacker-reachable SMB host, and many networks block 445 outbound. Claude Code ships this guard
> (v2.1.234, naming the vector); **opencode does not** — its only UNC handling is case-normalisation
> for display paths. The pre-existing rejection on the RELATIVE branch of
> `safeRelativePathUnderWorkspace` was never touched and still stands; only the absolute branch is
> unguarded. Re-open this if a Windows user is ever seen reading a network path, or if the sandbox
> gains a read-deny layer that could cover both tools at once.

- **Three IPC channels were unreachable from the renderer, one of them a live bug.** `preload.ts`
  gates `invoke` on `validInvokeChannels` and throws `Invalid channel: <name>`; registering the
  handler in `ipc_host` is NOT enough, and nothing before runtime notices. Caught by opening the
  packaged app: `doctor:run` failed loudly, and **`sessions:set-work-mode` would have failed
  SILENTLY** — its caller catches and logs a warning, so the per-session work mode simply would not
  have persisted. A new test (`preload-invoke-channels.test.ts`) asserts the whole surface
  mechanically, and it immediately found a **pre-existing** one:
  **`sessions:snapshot-turn-ids` was never allowlisted**, and its caller
  (`SimpleInlineChat.tsx:148`) swallows errors — so the revert-turn affordance has never rehydrated
  after a relaunch, which is the exact thing its own "Bug 6" comment says it was added to fix.
  **The test needed two fixes before it could be trusted** (~20 false positives on the first run):
  strip comments BEFORE matching quotes, because an apostrophe in a trailing `//` comment
  desynchronises quote-pairing for every entry after it; and scan only files that use the preload
  bridge, because main-process files call `invoke(` too and never pass through this gate.
  `get-node-path`, `compass:get-tier-catalog` and the four `ssh:*` channels are `IpcClient` methods
  with **no renderer caller** — left OUT of the allowlist deliberately (allowlisting a channel to
  quieten a test grants reach to something nobody can use) and listed as known-unreachable, with a
  guard that fires if one is ever allowlisted.
  **The standing rule: a new IPC channel is TWO edits** — the handler and the preload allowlist.
- **The memory store's location now opens the system prompt.** A DeepSeek V4 Pro session on
  `wisdom-drop` spent ~15 tool calls running `find` for `MEMORY.md`, then answered from a **stale
  hand-made backup** (`~/.atlarix-memory-backup-2026-08-19/`, content differs from live) — with the
  resolved path in its context the whole time. Proven from the logs for that turn: `memory-index=6ms
  memory-compaction=0ms`, and compaction only runs in the POPULATED branch, so the path and the index
  were both there. **Position was the problem, not wording.** Measured: the identity block sat FIFTH
  in `stableHeader`, putting the memory line 94% of the way through a 14,428-character header —
  orienting information arriving after all the procedure.
  `buildWorkstationIdentityBlock` now takes `memoryDir` and states it as **the only** store, and
  `runtimeIdentity` moved to position ONE. The line now sits at 4.6% (char 667); the header is the
  same length, so this is a pure reorder costing one cache-prefix invalidation and nothing after.
  **NOT AGENTS.md, though that is what was asked for** — `AGENTS_MD` is loaded once at startup and
  returned verbatim (`system_prompt.ts:114`), one global string for every workspace, so a
  per-workspace path could only go in as a `<slug>` placeholder: *the exact fillable-path bug that
  caused the stale-copy incident*. The identity block was already a per-dispatch template, so this
  needed no new mechanism.
  **PATH ONLY, never the note count** — the block is the prompt-cache prefix, same discipline that
  keeps `freemem()` out of the device line while cores and total RAM stay in. Count and index remain
  in the per-turn section.
  **This DELETED the empty-state branch** whose entire justification was being "the only place the
  absolute memory path is published" — an empty workspace now pays nothing per turn. Its test file
  survives, re-pointed at the guarantee (absolute path, never a guess, never a placeholder) rather
  than the mechanism, and renamed `memory-location-is-published.test.ts`.
  **Still unproven:** whether it changes the model's behaviour. The measurable check is re-running the
  same prompt on `wisdom-drop` and comparing tool-call count against the logged ~15. If it still
  hunts, placement was not the answer and the honest next step is a memory TOOL, not more prompt.
- **Debug is routed like build, not like ask.** The turn-runner selector read
  `settings.selectedChatMode === "ask"`, and `chatModeForWorkMode` maps everything except `build` to
  "ask" — so debug ran the ask branch with `singleRound: true`, keeping the SDK's inner multi-step
  loop but losing the OUTER agentic loop and the completion gates. Three places said that was wrong:
  `mode-tool-registry` ("debug = full surface, differs from build by prompt discipline only"),
  `isReadOnlyWorkMode` (debug is not read-only), and `run-agent-turn`'s "Build/debug: run the
  completion gates before ending". Fixed in the SELECTOR (`isReadOnlyWorkMode(effectiveWorkMode)`),
  not the mapping: anyone already on Debug has `selectedChatMode: "ask"` persisted, so a mapping-only
  fix would have done nothing for existing users — and the real question is "is this mode read-only?",
  which removes a proxy and leaves one source of truth. Verified low blast radius: `chatMode` is
  destructured as `_chatMode` (**unused**) in `constructSystemPromptParts`, so it drives no prompt
  content, and every other reader uses it for display or as a fallback.
  **The test method is the reusable part.** Request counts were tried first and were USELESS — ask and
  build both made 2 on the same scenario, so counting would have passed either way. Diffing the two
  branches' IPC channels found the real discriminator: only the build branch emits
  `chat:iteration:progress`, which IS the outer loop. The eval asserts comparatively (debug matches
  build, differs from ask) behind a sanity guard that fails if the signal ever stops separating them.
- **The memory location moved to the top of the prompt, in every mode.** See the reference-sweep and
  verification sections; the ask-branch half of it was found only by asserting against the DISPATCHED
  prompt rather than a hand-supplied argument — four of the five work modes were missing it.
- **A failed database open is no longer a dead end.** It showed "Database Error … Please restart the
  app" and quit — advice that is wrong for **every** case that can reach it, because
  `initializeDatabase` already retries once and DELETES the sqlite files before retrying. The one
  thing a restart could accomplish has already been tried automatically. `describeDatabaseInitFailure`
  now classifies the cause and `showMessageBoxSync` carries actions (Download / Show logs / Quit).
  **The branch that matters is the DOWNGRADE one** (`UnknownDrizzleMigrationHashError`): their data is
  newer than the app and perfectly healthy, so it must never be told to reinstall over it or delete
  anything — and it is matched by CLASS before any message pattern, because its own message contains
  "would corrupt DB", which a text-first classifier reads as a reason to wipe. The raw error stays in
  the dialog; classification adds a headline, it does not replace the detail. Title is "Atlarix can't
  start", not "Database Error" — the old one named our internals rather than the user's situation.
  Deliberately NOT wired in: the existing `reset-all` recovery, because a destructive button in an
  unexpected modal is worse than revealing the folder.
- **One floating promise stops paging the owner.** `main.ts`'s `browser-window-focus` handler called
  `broadcastWorkspacePathStatusesIfChanged()` (which reads the `apps` table) through a `void
  import().then()` with no `.catch` anywhere in the chain. Focus events keep arriving while the app
  tears down, so `DatabaseClosingError` escaped as an unhandled rejection and reached Sentry as
  `handled = no`. Fixed at the CALLER, matching its three sibling boot tasks — the guard in
  `db/index.ts` is right. The catch matches on `err.name` (it crosses a dynamic-import boundary), so
  `db-closing-guard.test.ts` now pins that name as contract: a rename would not break the build, it
  would silently downgrade the branch and the noise would return.
- **The retired tool names are out of the permission path.** Measured before touching anything:
  `edit_file` is emitted at **26** live sites, and `write_file`, `replace_code`, `insert_code`,
  `delete_lines`, `edit_file_section`, `batch_refactor` at **zero**. Removed from the operation-keyed
  gates (the interceptor's two switches, `FILE_OPS_WITH_SCOPE`, `CONTENT_WRITE_OPS`, the zod enum, the
  renderer union, and the `write_file || edit_file` pairs in the turn-runners) by dropping them from
  the type unions first and letting `tsc` enumerate all 13 sites. **Display entries KEPT** —
  `tool-activity-labels`, `tool-expand-view`, `stream-tool-display` and friends still render sessions
  persisted before v13.8.
  **Two things this FIXED rather than tidied.** `operation-targets.ts` ended `default: break`,
  returning no targets — and per that file's own header, a path missing from the list is a path that
  is never gated, so an unrecognized operation sailed through containment. It now fails CLOSED, which
  is what made removing the dead labels safe rather than a fail-open change. And
  `permissions/ruleset.ts` documented the deny-rule format as `write_file(.env*)`, so anyone copying
  our own example into `.atlarix/permissions.json` wrote a rule matching nothing.
  **Not done, deliberately:** collapsing the surviving sets into one shared constant. They are not the
  same set — `FILE_OPS_WITH_SCOPE` is {edit_file, delete_file, rename_file}, `CONTENT_WRITE_OPS` is
  {edit_file} — and merging two different questions to save a line would be worse than the repetition.
  The tool-name-keyed lists (`task-ledger`, `agentic-loop-repetition`, `useStreamChat`) were checked
  and LEFT: they match live tool names, so their stale entries are inert either way, and touching them
  buys nothing.
- **A provider error delivered as a successful finish no longer truncates a turn in silence.** A
  gateway can answer HTTP 200 with a clean stream whose `finish_reason` is `network_error`; nothing
  threw, so the silent retry never armed, and `run-agent-turn` read the mapped "unknown" as the model
  yielding. `stream_chunk_tags` now throws `ProviderFinishReasonError` on an error-shaped
  `rawFinishReason` (a field we never read) at BOTH the `finish-step` and `finish` seams — a one-step
  round reports only `finish`, so guarding the step alone would miss the common short-answer shape —
  and the existing jittered backoff does the rest. The classifier is a DENY list on error vocabulary,
  never an allow list of good values: a false positive would retry a completed answer and re-run its
  tools. `length` and `content_filter` are deliberately excluded.
- **The dead `write_multiple_files` permission cluster is gone.** No tool has emitted that operation
  since `write_file` folded into `edit_file`, and the only construction site bypassed buffering, so
  the card could never render. Had it rendered it would have shown ONE file's diff while approving
  every write in the batch, and "Always allow this file" would have saved nothing at all
  (`handlers.ts` read `.path` off an array preview). Removed the live path; **kept** the
  display-label / expand-view / stream-display entries, because sessions persisted before the removal
  still render cards under that name. The two array-preview branches in `operation-targets` and
  `extractRelativePathsFromPreview` **stay, re-keyed on SHAPE** — they feed containment checks, and an
  unrecognized array falling through would extract no targets, which fails OPEN.
- **Work mode belongs to the session** (`chat_sessions.work_mode`, migration 0074). The picker wrote
  a global, so reopening a session you were planning in from a window set to Build silently made the
  next turn a Build turn. Legacy rows stay NULL and keep resolving from the global preference; the
  first deliberate pick in a session stamps it. Every send now passes `workModeOverride`, so main
  never re-reads a global for a per-session decision — **but only when the turn's session IS the
  active one**, or a background chat would inherit the mode of whatever is on screen, which is the
  same bug in a new place. `drizzle-kit` bumped 0.30.6 → 0.31.10 first, as the queue required.
- **A cold chat's renderer state is now freed.** The view was windowed; the data behind it was not.
  Cold = **not the visually-active chat AND not streaming** — an open tab does not protect it.
  `useEvictColdChatState` (mounted once in the layout) prunes on deactivation via
  `clearChatAtomsForChat(id, {reason:"evicted"})`, which now also drops the `atomFamily` entries
  (they cache one wrapper atom per key for ever, one per MESSAGE id being the larger leak).
  **The blocker first:** `ChatTabStrip.switchToTab` only flipped ids, so the atoms were the only copy
  of a background session's history — activation had to become re-loadable before anything could be
  freed, which is why the session load now lives in `hydrate-session-into-chat.ts` and the tab strip
  calls it. **Eviction is tracked explicitly** (`evictedChatIdsAtom`) rather than inferred from
  "are the messages there": a background stream repopulates messages by itself (main sends the whole
  list per chunk) but nothing rebuilds the per-message display atoms, so a streamed evicted chat would
  come back looking complete and render its earlier turns stripped of their tool cards.
  **Found while testing:** `interleavedDisplayContentByMessageIdAtom` was missing from the original
  v12 pruner, so it leaked on session DELETE too — and it holds the fully rendered body of every
  assistant turn.
- **Settings → Diagnostics** (the doctor), plus `--doctor` from a terminal. Reuses the self-test's
  `SelfTestProbe` contract and `runSelfTest` — the native and sandbox rows ARE its probes, imported,
  not reimplemented — with a 12s budget instead of 45s, and `child-exec` / `fs-outside-container`
  excluded as inappropriate in front of a user. Updates are NOT a probe: `UpdateDiagnostics` already
  owned that surface and is rendered inside the section rather than duplicated as a row that could
  disagree with it. Keys are checked with a models-list call, **never a completion**, so running a
  diagnostic cannot cost the user money. Copy-report redaction lives in main with its own tests and is
  **shape-based, not a list of known prefixes** — the first provider to ship a new key format would
  otherwise leak it. `--doctor` waits for `whenReady` (unlike `--self-test`, because `safeStorage`
  needs it), takes no single-instance lock, opens no window, and exits with `app.exit()`.
  **Why the CLI exists:** a DB init failure shows a modal and QUITS, so Settings is unreachable in
  exactly the case you most need a diagnostic — which is also why the keys row reports "the local
  database is unavailable" instead of surfacing a native ABI error under a row about API keys.
- **Clicking Skills on Free no longer opens a checkout.** `SettingsPage`'s `SkillsCard` intercepted
  its own click and called `triggerUpgrade()`, which opens the Lemon Squeezy page in the system
  browser — so a Free user who tapped a settings row was thrown out of the app into a payment page
  having asked for nothing. It now navigates to `/settings/skills` on every tier and the page states
  the tier, exactly as `McpMarketplaceTab` does. **The rule:** a navigation affordance navigates;
  only a button that says Upgrade may open a checkout. Two other `triggerUpgrade()` call sites are
  correct (the sidebar's explicit Upgrade button, `ChatErrorBox`'s upgrade CTA);
  **`open-workspace.ts:43` is the same anti-pattern** — opening a second workspace on Free launches
  the checkout — left alone because a workspace limit has no page to land on, but it deserves a
  dialog rather than a browser tab.

## 🔬 Reference sweep — read 2026-08-21, all of it landed

Read against `claude-code` **v2.1.238**, `opencode` **dev @ 57fa34f2** (v1.18.20) and
`openai/codex` **rust-v0.149.0**, all 2026-08-20. Every item was checked against OUR code before it
was written down, and everything below is now implemented — see the Unreleased section above for
what each one was. Kept here only for the standing lesson each one carries:

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

**What this shipped WITHOUT, and it is a money path: refunds.** See the refund section below.

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

## 🩺 `--doctor` blames the database for a failure the database row disproves

Seen on the packaged v14.38.0 build, 2026-08-27, and pre-existing (the code is
v14.36.0's):

```
WARN  Your API keys (0ms)
      Could not read your saved keys — the local database is unavailable.
      Fix the Local database row first...
OK    Local database (11ms)   better-sqlite3 ok (sqlite 3.53.2, ABI 148)
```

Both rows are in the same report. The instruction it gives cannot be followed,
because the row it points at is green.

**The bug is the catch, not the check.** `doctor.ts:238-245` wraps
`import("../ipc/shared/provider_api_keys")` and rewrites ANY failure as "the
local database is unavailable" — a guess that was right for the native-ABI case
it was written for and is wrong for every other. `0ms` says the import threw
immediately, so it is not a database timeout at all; and because the catch
discards the original error, **the real cause is unknowable from the report**.
A diagnostic that destroys its own evidence is worse than one that says nothing.

**THE REAL CAUSE, found in the packaged app's own log the same run:**

```
[warn] (settings) Could not decrypt one or more stored secrets right now
       ... Error: safeStorage cannot be used before app is ready
```

So provider keys genuinely cannot be read — but because `safeStorage` is being
touched before `app.whenReady()`, not because SQLite is down. Two bugs stacked:
a startup-ordering fault in settings, and a catch that reports it as something
else entirely. The second is what made the first take a packaged run to find.

**Fix, in order:** (1) do not touch `safeStorage` before the app is ready — the
warning says the values are KEPT, so this is an ordering fault rather than data
loss, and its own text already tells the user not to re-enter anything; (2) keep
doctor's friendly sentence but append the actual error and stop asserting a cause
the report can contradict. Reproduce with
`out/Atlarix-darwin-arm64/Atlarix.app/Contents/MacOS/atlarix --doctor`.

**Also seen once and NOT reproducible:** the Core check timed out at 12s on the
first run after packaging, then passed in 1.7s on the second. Cold session
refresh, most likely. Worth a second look only if it recurs on a warm run.

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
- **Rename the macOS bundle identifier — its own release, NEVER a rider.** It ships as
  `com.electron.atlarix`, @electron/packager's default (`packagerConfig` never set `appBundleId`),
  confirmed against a packaged `Info.plist`. **The risk:** macOS ties `safeStorage`'s keychain ACL to
  the app's designated requirement, which includes the bundle id — so a rename can leave every user's
  stored provider keys and Supabase session undecryptable, which is exactly the failure v14.27.0 was
  about. It also resets TCC folder grants and orphans the Launch Services `atlarix://` registration.
  **No longer orphans passkeys** — the `keychain-access-groups` entitlement that baked the bundle id
  into a signed entitlement has been removed (below), so this rename got cheaper. It should still
  come BEFORE any Apple portal work, or that work gets done twice. **Not at risk:** `~/Library/Application Support/Atlarix` is keyed on the
  app NAME, so chats and workspaces survive. Needs a `safeStorage` re-encryption migration and an
  upgrade-in-place test on a **signed** build. Cost of waiting is one round of passkey re-registration.
- **Two removable dependencies** — `@types/node-cron` (node-cron@4 ships its own types, so this is a
  dead v3 stub) and `ignore` (nothing imports it; `isomorphic-git` carries its own v5 in a separate
  tree, so dropping our v7 root cannot lower it; added in the fork era, `e900b590`). **`axios`,
  `bluebird` and `@mixmark-io/domino` are NOT removable** — see the packaging trap below.
- **Atlarix GitHub account** for contributor credit (owner action; code done).
- OAuth `state` nonce / PKCE stays **not doing** — attempted v14.12.0, broke sign-in, reverted. The
  flow-in-progress gate stays. Revisiting needs confirmation that the Supabase redirect-URL
  allowlist permits a query param.

## 🔐 A security pass over the WHOLE topology — owner's ask, 2026-08-27

> *"make sure we are secure so … the pr bot and the systems we have are secure and won't be hacked
> or get stolen data."* Scoped deliberately: the 2026-07 audits covered the DESKTOP APP and the
> Supabase project. Since then two things went live that were not in that scope — a **public GitHub
> App with write access to customers' pull requests**, and a **money path anyone on the internet can
> POST to**. Neither has ever been audited.

**Where the real exposure is, ranked by what an attacker actually gets:**

- **`REVIEWER_SERVICE_TOKEN` bills any account.** The proxy TRUSTS the `x-atlarix-account-id` header
  on the service path (a PR webhook fires with nobody signed in, so `auth.uid()` is null and no
  owner-scoped RPC works). A leaked token therefore lets the holder spend any customer's wallet.
  The cross-check exists and is unused: the reviewer already resolves the account from
  `github_installs`, so the proxy could verify the claimed account actually owns an installation.
  Cheap, and it turns a bearer secret into a bearer secret **plus** a consistency check.
- **The reviewer holds a Supabase `service_role` key**, which bypasses RLS on every table including
  `credit_wallet`. The honest claim today is "it holds one and never uses it to move money"; a
  Postgres role scoped to its four tables and its RPCs would make the boundary real rather than
  behavioural. Now **five** RPCs with `refund_grant_service`, so the scope widens the longer it waits.
- **The model reads attacker-authored text.** A pull request's diff, title and body are written by
  whoever opened it, and on a public repo that is anyone. Prompt injection aimed at the reviewer is
  the obvious attack and there is no boundary marking that content as untrusted today. The
  containment that limits the blast radius is real and worth stating: the write client posts
  `event: "COMMENT"` only, so the worst outcome is a wrong or hostile REVIEW, not a push. Verify that
  is still true, and that no tool the reviewer holds can reach the wallet or another repo.
- **`handle-lemon-webhook` is `verify_jwt: false` by necessity** — LemonSqueezy sends no JWT — so the
  HMAC is the only thing standing between the internet and the credit ledger. It is verified against
  the raw body in constant time, which is right; what is unaudited is everything downstream of a
  VALID signature, now including the refund paths that MOVE MONEY BACK. A replayed refund, a forged
  `custom_data.supabase_user_id`, an invoice id reused as a ref across accounts.
- **`bind-github-install` is the account-takeover surface** and was tested against a real attacker
  account (forged codes refused at every layer). The one layer NOT covered is a VALID code from an
  account that does not administer the target → `installation_not_yours`. `atlarix-agent` can do it.
- **Secrets inventory across FOUR deployment targets** — Railway (reviewer + proxy), Supabase edge
  functions, GitHub Actions, and the App's private key on the owner's disk. There is no rotation
  story for any of them and no record of which are recoverable if leaked. The App private key is the
  worst one: it authenticates as the bot to every installation.

**Do it the way 2026-07 was done** — parallel agents per surface, findings written to a document,
then remediate Critical→Low with a coverage table, per
[[atlarix-security-fix-all-findings]]. **Do not push that document public.** Note what the earlier
audits already settled so they are not re-litigated: model-context secret redaction is CLOSED
(decided twice), and `.env` inside a workspace is deliberately enumerable.

## 📚 The docs are stale — owner's ask, 2026-08-27

> Same class of problem the pricing copy had, and found the same way: the site said Pro was
> pay-as-you-go while the account page said Pro included Core, and both shipped.

- **Already fixed in the v14.38.0 sweep, so start from what is left:** `guideDocs.ts:36,251` and
  `helpDocs.ts:259` ("Both Free and Pro pay the same way"), `PricingPage` FAQ + meta, and the
  `PricingTiers` "no plan bundles AI" callout.
- **Read `ALL_DOCS` end to end against what the app does now.** `src/data/helpDocs.ts` +
  `guideDocs.ts` are the in-app error buttons' destinations, so a stale doc is reached by someone who
  is already stuck. The v14.35.0 Dyad-era removal alone deleted ~30,500 lines; anything describing
  retrieval, indexing or the old panel-based approvals is describing software that no longer exists.
- **The blog posts are dated artifacts and should NOT be rewritten** — `blogPostContent.ts` carries
  pricing tables that were true when published. Leave them; the fix for a stale post is a new post.
- **Atlarix's own `README.md` and `docs/` too**, not just the site: the README's feature list is the
  most-read description of the product and nothing verifies it against the code.
- **The check that would stop it recurring:** every claim about pricing or plans now has ONE home
  (`src/shared/billing_copy.ts` and the launchpad's `src/data/products.ts`). Route the docs through
  those rather than restating them, and the next change propagates instead of drifting.

## 🧭 Designed — awaiting a session

### atlarix-launchpad: the site sells one product and we now have two

> Owner's ask, 2026-08-26. Measured before writing this, because the gap is wider than "add a login
> link": **the marketing site does not mention the reviewer anywhere.** Every match for
> "Atlarix Reviewer" / "pull-request review" in `src/` is in the account pages built today. There is
> no product page, no nav entry, no pricing row, and no link to the GitHub App — which is now PUBLIC
> and installable, so the thing exists and the site says otherwise.

- **Sign in is effectively hidden.** `/account` is linked from exactly ONE place (`Footer.tsx`, in the
  Product column) and `/login` from nowhere at all. A returning customer has to scroll to the footer
  or know the URL. It needs a header affordance.
  **But do NOT make the header session-aware to do it** — `useAuth` in `Header.tsx` mounts the Supabase
  client on all ~40 prerendered marketing pages and adds a signed-out→signed-in hydration flash to
  every one. A static "Sign in" / "Account" link costs nothing and `/account` already redirects to
  `/login?next=/account` on its own.
- **There is no signup, conceptually.** OAuth creates the account on first sign-in, so no separate flow
  is needed — but nothing on the site *invites* it. One label doing both ("Sign in" is enough; avoid
  "Sign up" as a second entry point that leads to the same two buttons).
- **The reviewer needs somewhere to live.** At minimum a section or page covering: what it does, that
  it never executes code (this is the differentiator and it is already written in the App
  description and `SECURITY.md` — reuse, don't rewrite), the install link
  `https://github.com/apps/atlarixagent/installations/new`, and $19/dev/mo with OSS free.
- **Pricing page covers Free vs Pro only, and has ZERO purchase CTAs** (`grep -cE "onClick|checkout|Subscribe|Buy"` → 0; the only call to action on the whole page is a Download link). Now that
  `create-checkout` works from the browser and `/account` can buy, the pricing table can actually sell
  rather than describe. It also needs a Reviewer column or its own row.
- **The FAQ is already stale on the thing we just changed.** `PricingPage.tsx:25` still says Pro is for
  "unlimited workspaces, automations, and the marketplace" — that predates Pro including a monthly Core
  allowance, and it is the same wrong framing being fixed inside the app. Fix both from one source of
  words, or they will drift again.
- **Sequencing note:** the LemonSqueezy post-purchase buttons already point at `/reviewer/setup`, and
  that page is live — so the funnel works for anyone who reaches a checkout. This work is about people
  who arrive at the *site* first, which is most of them.

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

### The app still talks like Pro gates AI. It does not any more.

> Owner's ask, 2026-08-26, and it follows directly from the pricing change: **Pro
> now INCLUDES a monthly Core allowance**, so the tier is no longer the thing
> standing between a user and a model. Most of the app's paywall language predates
> that and is now either wrong or actively discouraging. The framing to land on is
> that Free is a real product and Pro is prepaid AI — which is close to "Pro is
> arguably free", since the fee largely buys the credit back.

- **Rewrite the warnings, do not just soften them.** The distinction that matters
  to a user is no longer *free vs pro* but **allowance left / credit left /
  neither**. Two messages replace most of what is there: **"Your monthly Pro
  usage is used up"** (allowance spent, purchased credit still available or not)
  and **"Your top-up is used up"** (both gone). Neither should mention tiers.
  Audit every gate before rewriting: `useUpgrade`/`triggerUpgrade`, the PAYG
  error UX in `simple-stream-text.ts`'s `onError` (402 / 503 mapping),
  `useLowBalanceNudge`'s toast, `AtlarixCoreUsageCard`'s copy, and the
  `--doctor` line in `src/main/doctor.ts:128`. **The trap:** these are separate
  copies of the same idea in five places, which is exactly how they came to
  disagree in the first place — put the message in one module and have all five
  read it.
- **A usage bar in account settings, and the data already exists.**
  `get_credit_balance` now returns `granted_cents` and `purchased_cents`
  alongside the total, and the desktop app currently **throws both away** —
  `auth_handlers.ts` reads only `balance_cents`. So the bar is a client change,
  not a backend one: allowance consumed out of the month's grant, with purchased
  credit shown separately because it does not reset. **Do not render one merged
  number** — that is the mistake `/account` on the web deliberately avoids, and
  the reason is that a single total hides which half expires. The launchpad's
  `CreditCard.tsx` is the reference for the wording.
- **Show what the allowance is worth in real terms.** Measured on live data: app
  turns cost **2–29c each**, so a $10 monthly grant is roughly 200 turns. A bar
  with no scale invites "is that a lot?"; a bar that says "about 200 turns of
  everyday work" answers it.

### A small closable "what's new" panel, bottom-left

> Also the owner's ask, 2026-08-26, and deliberately modest: **the website
> changelog does the real work**, so this is a pointer, not a second changelog.

- Bottom-left, dismissible, and **stays dismissed** — a panel that returns on
  every launch is an advert. Key the dismissal on the version or entry id it
  showed, so a NEW entry can surface again without re-showing an old one.
- **Content we control, fetched not bundled.** Bundling means a note only reaches
  users who already updated, which is backwards for telling people an update
  exists. `atlarix-releases` already publishes assets the app reads
  (`ATLARIX_CORE_MODELS_URL` is the precedent for a remotely-controlled JSON),
  so a small `updates.json` beside it fits the pattern with no new
  infrastructure. Note the existing catalog trap applies: **ship an offline
  fallback and never let a fetch failure block or blank the UI** — an empty
  panel is better than a spinner, and no panel is better than an empty one.
- Keep it to a line or two plus a link to `/changelog`. The moment it wants
  scrolling it has become the changelog, and there already is one.
- **Not a notification system.** No badges, no unread counts, no server-side
  targeting. Those are a product; this is a footnote.

- **A refund path that understands GRANTED credit — POLICY SETTLED 2026-08-27, owner's four
  decisions. Do not re-argue these.**

  **Today's behaviour, measured:** `order_refunded` bails on `if (kind !== 'credit')` and
  `subscription_payment_refunded` has **no case at all**, so it hits `default:` and 200-ACKs.
  Refund a Pro month right now and the customer keeps Pro *and* keeps the allowance.

  1. **A refund of PURCHASED credit claws back the full refunded amount, even if already spent.**
     `credit_wallet.balance_cents` may go negative; that is not a new hazard, it is the existing
     documented design (`credit_wallet_service` has no floor, and `spend_from_wallet`'s own comment
     says that column "is allowed to go slightly negative … the proxy's pre-flight gate is what
     stops runaway spend"). Floor-at-zero would make buy → burn → refund free.
  2. **A GRANT is floored at zero, never negative.** `credit_grants.cents` never goes below zero
     today and must not start: a negative grant silently eats NEXT month's allowance, punishing a
     future period for a past one.
  3. **A refunded subscription month drops the tier IMMEDIATELY**, unlike a cancellation (which
     rightly runs to period end). A refund is the statement "this month did not happen"; leaving Pro
     active for a month you were paid nothing for is the strictly worse error.
  4. **Reviewer refunds are prorated-forward, never retroactive.** Reviews already posted cannot be
     un-posted, so the delivered work is never clawed back. `reviewer_subscriptions.status` is free
     text and `reviewer_entitlement_service` only accepts `('active','on_trial','cancelled')`, so
     `'refunded'` de-entitles with no CHECK to widen. It must NOT map to `'cancelled'` — that status
     stays entitled to period end.

  **The fee is not credit.** $19 bought entitlement plus a $10 allowance, so a Pro refund claws back
  the *grant* (proportionally to the refunded fraction of the invoice), never purchased credit —
  that is the user's own money from a different transaction.

  **Two traps carried over:** the refund event's object is a subscription INVOICE, so `event.data.id`
  is the invoice id and the subscription is `attributes.subscription_id` (same shape trap as
  `subscription_payment_success`); and `credit_transactions.kind` is CHECK-constrained, so a
  `grant_refund` ledger row needs the constraint widened or the insert raises 23514 on a path whose
  whole job is to move money back quietly. Partial refunds are real — LemonSqueezy carries
  `refunded_amount` on both the order and the invoice object, which is the field to read rather than
  `subtotal`.

  **Owner action that gates the whole thing:** `subscription_payment_refunded` must be ticked in the
  LemonSqueezy webhook settings. If it is not subscribed the branch never fires no matter what is
  written — exactly how the `subscription_payment_success` gap survived.

- **A `review-posted` automation event — closes the PR-review loop from this side.** One value added
  to `GithubTriggerEventSchema` (`src/lib/automations/types.ts`, today `new-pr` / `review-requested`
  / `ci-failed`) plus a poll branch in `src/lib/automations/pollers/github.ts`: a reviewer posts a
  review → the pipeline trigger fires → Atlarix reads the review comments via the GitHub API → the
  agent fixes them → pushes. **Works with ANY reviewer** — CodeRabbit, Cursor Bugbot, a human — so it
  has standalone value today and does not wait on
  [atlarix-reviewer](https://github.com/AmariahAK/atlarix-reviewer) shipping. That is the whole
  design: the two products are *composable*, not coupled, and the loop closes through GitHub's public
  review API rather than a private wire. The reverse direction (Atlarix writing a context payload for
  the bot to judge) was **cut** — it is unproven, no competitor has it, and a persuasive case for your
  own code handed to your own reviewer defeats the reason to have a separate reviewer at all.
  Reasoning in that repo's `docs/atlarix-pr-bot-spec.md` §5 and §16.

- **The catalog lags the vendor, and nothing dynamically covers the gap — for BYOK or for Core.**
  Found 2026-08-22 while checking whether Core could move `core-1` from GLM-5.2 to 5.3.
  **GLM-5.3 is live on the DIRECT pay-per-token endpoint** (`api.z.ai/api/paas/v4`, `created`
  2026-08-13, newest of 9 ids) and genuinely callable on our key — a live request returned
  `finish_reason: "tool_calls"` with a well-formed native tool call, plus
  `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens`. It is **not**
  in models.dev's `zai` row, which still stops at `glm-5.2` (2026-06-16); `zhipuai` stops there too,
  while 18 GATEWAY ids (`openrouter` as `z-ai/glm-5.3`, `vercel`, `requesty`, `kilo`, `venice`, …)
  already carry it. So the direct rows are the stragglers, not the catalog as a whole.
  **Core was deliberately NOT bumped** — owner's call, and the reason is a wallet effect, not a
  cosmetic one: `atlarix-releases/scripts/pick-core-model.mjs` reports `✗ NOT in models.dev — no
  price row, so this would bill at the RESERVE`, i.e. **every request bills at its worst-case reserve
  instead of actual cost, silently, with nothing erroring.** That script already exists for exactly
  this case (its header: "a vendor can ship a model before models.dev indexes it — that is exactly the
  case where you would otherwise paste an id that quietly bills at the reserve"), and it confirmed the
  rollback target exists (`z-ai/glm-5.3` is on OpenRouter). Re-run
  `ZHIPU_API_KEY=… node scripts/pick-core-model.mjs zai glm-5.3` and flip `core-models.json` when its
  first line turns ✓ — the config block it emits is the whole edit.
  **MEASURE THE LAG FIRST — that number decides whether any of this gets built.** 5.3 hit the API
  2026-08-13; record the date models.dev adds it under `zai`. Days means waiting is the right answer
  for ever and this item closes. Weeks, repeatedly, means the fallback has to become real.
  **The crux, if it does:** the provider's own `/models` cannot supply the missing half. It is
  OpenAI-compatible, so a row is `{id, object, created, owned_by}` — **ids and entitlement, never
  price or context window.** So "consult the live API" fixes existence checks and nothing about
  billing. A real fix needs a price source, which leaves: an explicit per-model price override in
  `core-models.json` for the gap window (Core only, and someone has to remember to remove it); or
  treating a missing row as **unknown** rather than worst-case and saying so in the UI — which is the
  honest option and the one that also serves **BYOK**, where the user picks any id their own key
  exposes and we have no say in whether the catalog knows it. Today both paths silently degrade:
  Core to reserve billing, BYOK to fallback limits (`source=fallback`) with a wrong token meter.
  Constraint that must survive any change: the catalog is a **union floor that never shrinks**, so
  waiting can never break `glm-5.2`.
- **Cached input is not credited on the zai tier** — separate, pre-existing, and true on 5.2 as much
  as 5.3. The live 5.3 response reported cache hits at `prompt_tokens_details.cached_tokens`, but the
  zai route carries `cacheHitField: null` (only `deepseek` sets one, `prompt_cache_hit_tokens`). So
  prompt-cache savings on GLM are measured by the provider and discarded by us. Small, and money in
  the user's favour to fix.

- **Streaming "jumps" are LAYOUT, not pacing — do not touch the pacer.** Reported as "smooth then
  jumped then smooth", and narrowed with the owner to "the tools & some reads & thoughts".
  `useSmoothStreamedContent` is **already adaptive**: `rate = min(MAX_CPS, BASE_CPS + backlog /
  CATCHUP_SECONDS)`, where the backlog term self-tunes to the provider's real arrival rate with no
  per-provider knowledge — which its docblock rejects deliberately, since with 4,400+ models such a
  table is wrong the day a provider changes infrastructure. The "~50 ms" is the renderer's flush
  interval UPSTREAM of the pacer, not a pacing knob. **Nothing there needs to become dynamic; it
  already is, and tuning those constants cannot fix what is being seen.**
  What is actually unpaced: the pacer has ONE consumer (`AssistantMessageBody.tsx:115`, assistant
  prose). Tool activity renders through `StreamThreadItemView` as cards inserted at full height — a
  layout insertion no reveal rate can smooth. And `InlineThoughtBlock` auto-collapses when streaming
  ends (`if (!isStreaming && !keepOpenAfterStream) setOpen(false)`), so everything below jumps up:
  **the single best match for smooth → jumped → smooth, and the place to start.**
  Candidate fixes are reserved height / transition on insert, and not collapsing while content is
  still arriving below. This is the most reflow-sensitive code in the renderer — it already produced
  one "scratchy rendering" regression — so do it with the packaged app open.


- **QA sub-agents, remaining half.** Shipped as a role. Still owed: **measure contract drift** —
  script a weak model over a multi-item coverage contract in `tests/agent-evals` and count dropped
  items. That number, not reasoning, decides whether a validated structured return is ever built.
  Recorded consequence of the no-gate decision: `browser_interact` has **no approval path in any
  mode**, so `DESIGN_NOTES`'s "destructive interactions go through the existing approval path"
  describes something that does not exist — and this is the first feature whose actions leave the
  machine, while our containment story is write-confinement, which says nothing about egress.
- **Run the session-load diagnostic** — `ATLARIX_DIAG_SESSION_LOAD=1` (main) +
  `localStorage["atlarix:diag:session-load"]="1"` (renderer), open the 1.43M-token session, record
  the four numbers. Ruled out: summarisation (zero compaction events in 13h of log) and tiktoken
  (memoised + delta-cached). Prime suspect `workspace_session_handlers.ts:751` —
  `parseDisplaySnapshot` per row on the main thread over a synchronous select with
  `SESSION_LOAD_MESSAGE_LIMIT = 100_000`. **A loading screen alone cannot fix it**: the overlay
  exists and cannot paint because nothing yields.
- **Configurable read-deny patterns, opencode-style** — user-declared only, no defaults; chosen over
  Codex's model because it keeps `lib/tools/glob.ts:221` intact (the deliberate decision that
  in-workspace files, `.env` included, are enumerable).
  **Take Claude Code v2.1.236's SEMANTICS — they are the hard part, and they are now shipped
  upstream:** a wildcard deny (`**/.env`) takes **precedence inside allowed read regions**, covers a
  matched **directory's contents**, and **cannot be bypassed by renaming** the denied file. That last
  one is the trap: a deny evaluated on the path as written is defeated by `mv .env x && cat x`, so it
  has to be enforced on the RESOLVED target. (The non-local-root guard added 2026-08-21 sits in
  `resolveToolTargetPath`, which is the same choke point this would use.)
  **The caveat dominates the estimate:** a deny-read is only real if `run_command` cannot `cat` the
  file. macOS Seatbelt and Linux Landlock
  are cheap; **Windows Low IL cannot** — MIC is `NO_WRITE_UP`, so reads up are allowed by design, and
  the AppContainer that *could* deny reads is exactly why it broke. Scope as tool-level everywhere +
  sandbox-level on macOS/Linux + a documented Windows gap.
- **Sub-agent results still don't *continue* in the timeline.** They render correctly; what remains
  is placement (round-panel cards behind an expand affordance rather than resolving inline).
  Direction: weave settled `subagent` items via `weaveIpcItemsIntoParts`, collapse the panel once all
  agents settle. **Why it keeps being skipped:** its entire value is visual placement, in the most
  reflow-sensitive code in the renderer — `AssistantMessageBody`'s sticky-agents / seam-offset /
  synthesized-round interaction, which already produced one "scratchy rendering" regression. Land it
  in a session that starts with the packaged app open.
- **`run_command` memory/CPU containment** (cgroups / Job Objects) — the orphan half is done; this is
  the runaway-build half, and there is no observed failure yet.
- **`llama-server` `/props`** for the true `n_ctx` and chat template. Reachable today as a custom
  OpenAI-compatible endpoint, just falling back to heuristics. One provider, not a systemic bug.
- **Nested-repo trust on mid-session clones** — does a repo cloned mid-session re-trigger
  authority-file approval? Prompt-injection weight only: hooks were deleted and no `.atlarix` file is
  shell-executed any more.
- **Packaging registry (deliberately deferred).** `runNpmInstall` (`forge.config.ts`) spawns npm with
  no `--registry`, in `buildPath` outside the project, so a custom global registry wins and
  `packageAfterPrune` dies with `E401`. Until it lands, `npm run package` needs
  `npm_config_registry=https://registry.npmjs.org/`. Held pending the owner's account migration.
- **Chore-model routing stays OPT-IN.** `lib/summarization_model.ts` already offers `"same"`
  (default) or `"custom"`, and titles + compaction both route through it. Defaulting Core users to
  Core 1 would silently change what they are paying for.
- **No test measures whether our own suite is sensitive** — no mutation testing, no eval where the
  fixture's suite is deliberately wrong, so "tests pass" is a claim about the suite, not the change.
  Two clean instances in v14.30.0; see `DESIGN_NOTES.md`.
- **User-message multimodal parts for HISTORICAL turns** — current and edited turns embed since
  v14.8.11; history round-trips via `read_attachment`.
- **A future e2e suite must be wired into CI on day one.** Never being in CI is why the last one
  rotted unnoticed since v14.15.0 until 88% of its selectors were dead. Write it fresh against the
  workspace UI; see `DESIGN_NOTES.md` for why it was retired rather than repaired.

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

## 🧪 A test whose fixture is not in the repo — caught by CI 2026-08-20

`plan-row-select-columns-exist.test.ts` read `supabase/audit/prod_schema.sql`, which is **gitignored**
(`.gitignore:14`). So it passed on the author's machine and could only ever fail in CI — which it did,
on the release run, with `ENOENT`. **A test whose fixture is not tracked is not a test**, and nothing
local can tell you: `npm test` is green either way.

It now replays `public.users` from the **migrations**, which are committed and are the source of truth
anyway — the same conclusion the ban migration reached the hard way the same day, since that snapshot
is also *stale* (it predates the pricing-reframe teardown).

**Say the weakening out loud:** the original bug was a column that existed in a migration but was not
DEPLOYED, and a migration replay cannot see that. This now catches a typo, a rename, and a column no
migration creates — not an undeployed one. That case is held by the runbook discipline of deploying
first and by the `isUserBanned` pattern of querying a new column in its own request that tolerates
absence. Getting the deployed-schema check back needs a real database, not a file.

Cheap standing check: for every repo-relative path a test reads, `git ls-files --error-unmatch` it.

## 🔴 v14.35.0 FAILED TO SHIP on the first tag — two independent regressions, 2026-08-20

The tag built, `quality` and `create-draft` went green, Linux and macOS-x64 uploaded, and **three of
six build jobs failed**. Nothing was published. Draft deleted and re-tagged rather than shipped
partial — a release with no Apple Silicon build and no `latest-mac.yml` would have broken macOS
auto-update for everyone.

### 1. Windows + MSIX: node-gyp could not find Visual Studio — DIAGNOSED AND FIXED

**Two latent defects in `@electron/node-gyp@10.2.0-electron.1`, both surfacing at once**, because
this is the FIRST release in which Windows CI has ever had to compile `better-sqlite3` from source.

**Why it is new, since nothing in the toolchain moved:** v14.34.0 built green on the *same*
`windows-2025-vs2026` image and **never ran the VS finder at all** — `grep -c "find VS"` on its log
is **0** — because better-sqlite3 arrived as a PREBUILT binary. Electron 43 (ABI 148) with
better-sqlite3 12.11.1 has no prebuild, so it compiles, which invokes the finder, which has been
broken all along.

1. **`execFile` with no `maxBuffer`** → Node's 1 MB default. `findNewVSUsingSetupModule` runs
   `Get-VSSetupInstance | ConvertTo-Json -Depth 3`, serialising every VS instance *and its full
   package list*; that exceeds 1 MB, `execFile` rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`,
   and the check returns null. **Fixed** by a patch-package patch raising it to 64 MB — and without
   it the log could not say what was actually wrong.
2. **No VS >= 18 support.** With the query no longer truncated the finder parses the instance and
   logs `unsupported version: 18` / `invalid versionYear: undefined`, falls through every older
   check, and reports "Could not find any Visual Studio installation to use". **NOT fixed** —
   worked around by pinning to `windows-2022`.

**TWO wrong guesses were made and corrected on the way, both stated confidently first:** that
better-sqlite3 12.11.1 pulled a newer node-gyp (`git log -S'@electron/node-gyp'` shows that
dependency unchanged since the initial commit), and that GitHub's image had "moved to VS 2026" (it
had VS 2026 two days earlier and built fine). The lesson is the cheap one: **check whether the code
path ran at all before theorising about why it failed.**

- [ ] **Un-pin Windows from `windows-2022`.** It is on GitHub's deprecation path and much colder
      (~5 min of setup, and the build step ran ~2.4x the v14.34.0 baseline of 7m41s), so the pin
      buys one release. The fix is to extend the existing patch so version 18 maps to year 2026, in
      the same `find-visualstudio.js`. Verify by the **absence** of `unsupported version: 18` in the
      gyp log, not by the build passing — a passing build proves a toolchain was found, not which one.
- **The `VCINSTALLDIR` route was considered and rejected:** `findVSFromSpecifiedLocation` gates on
  that env var and would skip PowerShell entirely, but it also needs `VSCMD_VER`, i.e. a real VS
  Developer Command Prompt — a third-party action in the release workflow.

### 2. macOS arm64: the SIGNED app would not launch — DIAGNOSED AND RESOLVED by removing the feature

`self-test:packaged` launched the Developer-ID-signed arm64 build and it **died in 75 ms having
printed nothing**. v14.34.0's identical step passed **8/8**, so it is a v14.35.0 regression.

Prime suspect is the passkey entitlement: `entitlements.mac.plist` — carrying
`keychain-access-groups: 7VWW7N9R87.com.electron.atlarix.webauthn` — **did not exist at v14.34.0**.
This is the first CI-signed build to apply it, and it is exactly the documented failure mode that
SIGKILLed `rg`: an entitlement the binary is not provisioned for is killed on exec while
`codesign -v` still calls it valid. Electron 38 → 43 is the other candidate. **No probe output means
it never reached JS**, which rules out anything in our own startup path — including
`configureWebAuthn`, which `--self-test` never reaches (it exits before `whenReady`).

Two diagnostics added rather than guessing:
- **`run-packaged-self-test.mjs` was throwing the evidence away.** `process.exit(result.status ?? 1)`
  turns a signal-kill (`status: null`) into a plain exit 1, which reads exactly like a failing probe.
  It now names the signal and points at `codesign -d --entitlements`. **A signal is not an exit code**,
  and conflating them hid the worst class of failure this project has.
- The macOS job now dumps the applied entitlements, a nested helper's entitlements, and the kernel /
  AMFI log on failure. None of it was recoverable afterwards — the app dies with the runner.

**RESOLVED 2026-08-20.** The diagnostic ran and said `SIGKILL`, with a valid Developer ID signature
(`flags=0x10000(runtime)`) carrying `keychain-access-groups`. That entitlement is **provisioned**:
outside the App Store it needs an embedded provisioning profile authorising the group, and without
one AMFI kills the process on exec. Same rule that killed `rg`; scoping the group to the top-level
bundle moved the victim rather than removing the requirement.

**The feature was removed rather than provisioned, and not as a compromise.** Electron's own docs:
credentials are stored in the app's keychain group, "bound to this device's Secure Enclave", with a
per-`session` secret "so that credentials created in one partition are not visible to another", and
"not synced via iCloud Keychain". So it could never use a passkey the user already had — it enrolled
a NEW one, Mac-bound, unsynced, visible only inside Atlarix's browser partition. A user would have
had a passkey that works nowhere else. Full reasoning in `DESIGN_NOTES.md`.

What shipped instead: the `select-webauthn-account` chooser (the fix for the actual hang) plus a
notice naming the roaming path. `entitlements.mac.plist`, `src/main/webauthn.ts` and the
`configureWebAuthn` call are gone; `optionsForFile` is back to one entitlements file.

### 3. macOS x64 "success" is not evidence, and that is by design

The x64 job never launches the packaged app: the self-test is gated on
`matrix.arch == process.arch` because an arm64 runner cannot execute an x64 binary natively, and it
prints a `::notice::` when it skips. So **only the arm64 job ever executes a signed build**, and x64
uploads assets nothing has launched even once. Deliberate and documented — but worth knowing that
"build-macos (x64): success" carries no runtime signal at all.

## 🪟 The packaged self-test did not EXIT on Windows — FIXED 2026-08-20 (`app.exit`)

Third Windows problem on the v14.35.0 tag, CI-only, and it cost a 22-minute hang plus a cancelled
release run. **`process.exit(code)` does not reliably terminate Electron's main process.** The app
printed `PASSED (9/9 probes)` and kept running. `app.exit(code)` before it fixed it: the Windows job
now completes in ~10.5 min and the release published.

**MY TWO-PROCESS THEORY WAS WRONG, and the pid stamp is what disproved it.** The log appeared to
contain both self-test output and a full `onReady()` boot, which looked impossible in one process, so
I concluded there were two and wrote down two candidate mechanisms (a fork booting as an app; the
hidden web-search window blocking `window-all-closed`). Stamping `process.pid` on every line showed:

- `pid=1452` = the harness's own **unit tests** under vitest (`ok-a`/`ok-b`/`boom`/`after`), never the app.
- `pid=972` = the packaged app, emitting all 9 probes — **twice**.

One app process. The duplication is the runner: `stdio: "inherit"` shows the lines live, and then it
dumps the Windows file sink ("--- captured output ---"). `[self-test]` lines go to BOTH, electron-log
lines only to stdout — which is exactly why probes appeared twice and `main onReady started` once, and
why it read as two boots. **Neither candidate mechanism was real.** Both are withdrawn.

**Still genuinely open, but no longer harmful:** `onReady()` runs in the `--self-test` process even
though it is called only inside `if (!IS_SELF_TEST)` (`main.ts:1516`). Worth understanding — a
self-test that boots the whole app is testing more than it claims to — but `app.exit()` now terminates
it either way.

- [ ] **Work out why `onReady()` runs under `--self-test`.** Not a hang risk any more; it is a
      correctness question about what the probes actually exercise. Start from the transitive imports
      in `main/self-test.ts`, which pull in app subsystems (`runShellCommand`, `wrap-command`,
      `start_proxy_server`) and may carry boot side effects.

**The durable lesson, third instance today:** identify the writer before theorising about the
behaviour. One `process.pid` in the log format answered in one run what three rounds of reasoning got
wrong.

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
