# Atlarix TODO

**Current Version:** v14.34.0 (2026-08-18) — released. **v14.35.0 is IN FLIGHT, not tagged:**
Electron 43, Touch ID passkeys, a dependency/security sweep that took production vulnerabilities
from 54 to 28, the **Dyad-era removal (~30,500 lines)**, a **plan switcher**, **plan-by-title**,
**automations returning their id**, the **ban system**, the **whisper-worker CSP**, and **four plan-
tracking fixes** (steps stay ticked).
**Last Updated:** 2026-08-20

> **What belongs here:** open work, decisions still owed, and traps worth not rediscovering.
> **What does not:** shipped narrative → [`docs/CHANGELOG.md`](./CHANGELOG.md). Designed-but-unscheduled
> work → [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md). Both get a one-line pointer here and nothing
> more. Trimmed 2026-08-11, 2026-08-15, and audited against the code 2026-08-19; `git log --
> docs/TODO.md` has every word.

## What is actually left — re-audited after the sweep, 2026-08-19 (later)

The Dyad-era removal and five of the six code tasks are DONE (six commits; see
`CHANGELOG.md`). What the sweep changed about this list:

- **~30,500 lines deleted, not ~1,900.** The earlier estimate measured only `src/`. It missed a
  fourth unreachable cluster, two vendored npm packages, and a 68-spec e2e suite.
- **`grep -ri dyad src/ shared/` is now 0.** The one remaining reference is `src/pro/LICENSE`
  (FSL-1.1, Copyright Dyad Tech, Inc.), which covers `search_replace_parser.ts` /
  `search_replace_processor.ts` — both LIVE. Deleting a licence for code you still ship is not
  cleanup, so the target has an exception and always did.

**Second follow-up pass, same day — all five loose ends closed.** Six more commits: Cmd+R unbound at
the menu (it was bound by `role: "viewMenu"` all along, so the renderer handler was fighting a menu
item); the search-replace path deleted with `src/pro/LICENSE`, which is what finally made `grep dyad`
reachable rather than the target being wrong; the e2e suite retired (60 of its 68 testids no longer
existed — 88%); `IS_TEST_BUILD` swept; Anthropic extended thinking actually requested; and a
re-runnable ban-guard proof. Plus the launchpad SEO fix. Details in `CHANGELOG.md`.

**`grep -rni dyad` is now ZERO across all tracked code outside `docs/`.** The remaining hits are
archived opencode benchmark transcripts and one base64 lockfile integrity hash that happens to contain
the substring.

**Still open:**

- **RESOLVED — all four plan-tracking bugs.** The lost-update race (serialised writes, re-read inside
  the lock), the byte-exact `step_text` match, the ledger hiding every in-progress step but the first,
  and the round-boundary stale ledger (below). The fourth was the one the owner reported as
  "notifications saying 1/6"; the other three were found underneath it.
- **1 code task** — the Console + Network packaged pass, owed since v14.31.0. Verification only, no
  code expected. **Not attemptable headlessly:** it needs a workspace open, a browser tab driven by
  hand, and a live turn (so an API key and a model). The packaged build itself is verified —
  `self-test:packaged` **9/9** on 2026-08-19, including the `sqlite` probe, after all six commits.
  That matters most for commits 1 and 3, which dropped IPC channels: a dropped channel still
  compiles and only fails at runtime, and nothing failed.
- **1 Windows session** — unchanged; every fix in that section is already shipped and the
  checkboxes are its verification checklist.
- **1 owner decision** — the five unused dependencies (the Windows signing cert is release-infra).
- **2 release-owed** — a CI-signed build and the Windows/Linux packaged passes.
- **1 verification owed on the Anthropic fix — it is BELIEVED fixed, not OBSERVED fixed.** The
  capability branch, the SDK-shaped `budgetTokens` and the temperature omission are covered by 12
  tests (verified sensitive: removing the branch fails 5, reverting the temperature omission fails 1).
  But there is no Anthropic key here and the failure mode is a provider-side **400**, so the request
  has never actually been sent. **The check:** one reasoning prompt on a Claude model with a real BYOK
  Anthropic key — confirm no 400, and that thinking parts stream. If it 400s, suspect temperature:
  Anthropic accepts only `1` with thinking on, and `getTemperature` defaults to `0`, which is exactly
  why `shouldOmitTemperature` exists.
- **RESOLVED — the e2e suite is retired.** 60 of its 68 testids no longer existed in `src` (88%),
  including `chat-input-container`, `messages-list` and `chat-mode-selector` — it tested a different
  application. Deleted with playwright.config, merge.config, three npm scripts, two devDeps and eight
  config references. A future suite should be written fresh against the workspace UI **and wired into
  CI on day one**: never being in CI is why this one rotted unnoticed since v14.15.0.
- **RESOLVED — the ban guard is observed, not asserted.** `npm run verify:ban-guard` extracts the
  trigger from the migration (never a copy) and proves both directions on a local Postgres:
  `authenticated` cannot clear its own `banned_at`, `service_role` still can. Verified the check
  itself catches both a deleted clause AND a present-but-unenforced one (`is_admin := true`). It does
  not prove Supabase's real RLS wiring — `docs/BAN_RUNBOOK.md` keeps the production check.

### Corrections the sweep produced — the manifest was wrong in these places

Recorded because the section's own lesson is *check reachability before scoping*, and the audit
itself had measured presence one level down:

| Claim | Actually |
| --- | --- |
| Three unreachable clusters | **Four.** `src/pro/main` visual editing — 1,101 lines, registered at `ipc_host.ts:41`, zero renderer callers, and 617 of those lines were a test file proving unreachable code still worked |
| ~1,900 lines | **~30,500** across 146 files |
| `selectedComponents` "read by nothing on the main side" | It WAS read (`chat_stream_handlers.ts:789`) and did real work; it was dead because the atom was only ever *cleared* |
| "DO NOT delete `versioned_codebase_context.ts`" | Deleted. The work was real, the callers were not — its only consumer was the engine path, and its matching WRITE half went with it |
| 8 defensive `auto` sites to sweep | ~12, at different paths — and **most were KEPT**: they catch a stale persisted `selectedModel.provider === "auto"` from before routing was removed, so deleting them would regress an upgrade path. Only 2 were genuinely dead |
| `layout.tsx`'s Cmd+R effect is "a no-op" | **KEPT.** Its `preventDefault()` runs unconditionally and is what stops Cmd+R reloading the renderer — deleting it would let the shortcut kill a live turn |
| `dyad-pnpm` shim: keep one release | Moot. `runtimeMode2` has **zero writers** repo-wide, so Docker mode never ran and no such volume could exist |
| 4 capacitor channels | 6 — `open-ios`/`open-android` were registered by the deleted handler with no callers |
| `plans:list-by-session` "already exists, called by nothing" | Did not exist. But `listPlanArtifactsForSession` DID, so the handler was a ten-line wrapper; the work was the picker's **pin** |
| automations id: "the permission envelope is the obstacle" | It is not. `getExecutionResult` → `jsonAfterSuccessfulExec` already existed, and `verified` was the exact precedent |
| `cleanFullResponse`'s 2 dyad tests die | 0 died — stale test NAMES over `atlarix`-tag bodies. Renamed |

Also found and removed on the way, none of it in the manifest: `isPreviewOpenAtom` (written once,
read by nothing), the `refresh` suggested action (a user-reachable "Refresh app" button whose handler
bumped an unread atom), `providerOptions["dyad-gateway"]` (inert — no provider declares it), the
`atlarix://pro-return` deep link (the last way an `auto` key could be written, so the C5 confirmation
dialog went with it), and `atlarixProBudget` (schema-only, no readers).

**The lesson, restated:** the first audit checked reachability of *code* but not of *directories*. It
enumerated `src/` and stopped, so `e2e-tests/`, `packages/` and `src/pro/` were invisible to it —
three of the four biggest finds. Scope by what the repo contains, not by where you last looked.

---

## 🔨 In flight — landed, not yet released

**v14.35.0 is unreleased and untagged, and now contains everything below** — the Electron 43 work,
the four spec-line majors (merged fast-forward from `migration`), the passkey correction, and the
browser-backed web search, all shipping as ONE release.

**Electron 43 + passkeys + the dependency/security sweep.** Full suite green, and
**`self-test:packaged` PASSES 9/9 on macOS** — including the new `sqlite` probe reporting
`better-sqlite3 ok (sqlite 3.53.2, ABI 148)`, which is the Electron 43 native rebuild proving itself
in the packaged app. **Still owed: a CI-SIGNED build (local packages are ad-hoc signed, so passkeys
cannot be exercised here at all), and Windows + Linux.**

### Passkeys, corrected — the notice was wrong on Windows and Linux

Shipped on `main` after the merge. The v14.35.0 implementation told every Windows/Linux user
"Passkey sign-in is not available… open this page in your normal browser", **which is false.**

**Only the PLATFORM authenticator needs the macOS-only `app.configureWebAuthn`.** Roaming
authenticators — a USB security key, or a phone over the hybrid/QR flow — go through Chromium and
work on every platform; Electron's own `select-webauthn-account` docs say the event "may also fire on
other platforms when a roaming FIDO2 authenticator returns multiple discoverable credentials". The
notice was steering users off a path that works.

- The message now says a passkey **stored on this device** is unavailable and that a security key or
  phone may still work.
- It is **suppressed entirely** for a request that explicitly asks for roaming —
  `authenticatorSelection.authenticatorAttachment === "cross-platform"` on `create()`, or an
  `allowCredentials` list whose transports are all non-`internal` on `get()`. **Anything UNSTATED is
  still reported**, because an unstated request may resolve to the platform authenticator; going
  quiet there would hide a real dead end.
- The chooser no longer declines. Several credentials now raise a native `dialog.showMessageBox`
  list (`displayName` → `name` → positional). **The callback contract is the dangerous part** —
  Electron holds the credential request open until it runs, exactly once, so it fires from a
  `finally` and a dialog that throws declines rather than hanging. That is the same failure class as
  the approval card that hung a turn for ten minutes, so it is pinned by its own test.

**Still not verifiable locally:** ad-hoc-signed builds strip the entitlement, so all of this needs a
CI-signed build plus the Windows/Linux machine.

### `migration` branch — the spec-line majors (4 commits, all green)

Cut from post-v14.35.0 `main`, one revertable commit each. Suite stayed at the pre-migration
baseline (369 files / 3105 tests) through all four; `self-test:packaged` 9/9 after each of the two
that could break packaging.

**`ai@6→7` + 11 providers (v3→v4 spec) + `zod@3→4`.** Gated on a spike first, because ai@7 and every
v4 provider are ESM-ONLY with no `require` condition while we externalise them and `require()` from a
CJS main bundle: `require(esm)` works under Electron 43's Node 24 (no top-level await in the graph),
proven by loading the real packages before migrating anything.

- **22 of the compile errors were one mistake repeated** — seven files spelled the model type
  `LanguageModelV2 | LanguageModelV3`, a union needing a hand-edit every SDK major. `ai` exports a
  version-agnostic `LanguageModel`; there is now one `AtlarixLanguageModel` alias and the next spec
  bump costs nothing.
- **THE ONE THAT WOULD HAVE SHIPPED SILENTLY: `response.messages` became final-step-only.**
  `bundle.response` is deprecated in v7 and resolves to `finalStep.response`, so any turn whose tool
  call ran in an EARLIER step lost its entire native tool exchange, and the next turn carried no
  `role:"tool"` history. Same types, same shape — it fails only across turns, and only the
  native-history evals caught it. Use v7's accumulated **`responseMessages`**.
- **v7 rejects `role:"system"` inside `messages`** (65 evals). That placement is deliberate — it IS
  the v10.1 prompt-cache layout. Re-permitted with `allowSystemInMessages: true` so the layout stays
  byte-identical and measurable. Moving it into v7's `instructions` (which accepts
  `Array<SystemModelMessage>`, so breakpoints could survive) is the aligned end state and needs its
  own commit plus its own `[prompt-cache] read=` measurement.
- Smaller: `toModelOutput` takes an options object and its result type moved to `provider-utils`; the
  tool-image part is now a tagged `{type:"file", data:{type:"data"}}`; a tool `description` can be a
  FUNCTION of call context. `usage` is cumulative now — checked, and it only moves a BYOK *estimate*
  and a display figure, since the Core wallet is debited at the proxy; no double-count, and it fixes
  an under-count. zod 4 was a non-event (all four `z.record()` sites already pass two args).

**`vite@5→8` + `vitest@3→4`.** I first capped this at vite 6 by REASONING that vite 7+ ship no
`require` condition and forge's plugin is CJS — and that was wrong, because I never tested it.
`require("vite")` resolves at 8.2.1 under both system and Electron Node, and both of forge's interop
shapes hold (`loadConfigFromFile` named; `__importDefault(...).default.build`, the namespace having
no `__esModule` so the helper wraps correctly). **Measure the thing; do not infer it from a manifest.**

- **The `overrides` had to go first** — exact pins on `vitest`/`vite-node` made the install fail with
  `EOVERRIDE`, which was the lucky outcome: a RANGE there would have silently held vitest at 3 and
  the upgrade would have "succeeded" while changing nothing. `vite-node` does not exist in vitest 4.
- **`vitest` + `@vitest/ui` stay EXACT** — their peer link is an exact version, not a range.
- **The packaged gate caught a launch crash everything else missed.** Tests, all three type projects,
  lint and `PACKAGE EXIT=0` were green, and the app still died before drawing a window:
  `fileURLToPath(undefined)`. `node-cron` publishes both conditions; vite 5 took the CJS one (which
  uses `__dirname`), vite 8 takes the ESM one and compiles `import.meta.url` to **`{}.url`** —
  undefined in a CJS build. Five other bundled packages hit the same transform and survived because
  they guard it (`typeof {}.url === "string" ? … : __dirname`, or a try/catch); only node-cron did
  not. **Externalised, which is right regardless of bundler:** it FORKS a sibling `daemon.js` located
  via `import.meta.url`, a disk lookup that cannot work inside an asar — so that path was already
  broken quietly and vite 8 merely made it loud.
- Fell out of the churn: dropping vitest 3 pruned a TRANSITIVE `@types/babel__traverse` our own
  source relied on (`visual_editing_utils.ts` imports `@babel/traverse` directly). Now declared.

**`typescript@5.9→7`** — the native Go port, platform binaries as optionalDependencies.
`lib/tsc.js` survives as a shim so all three type-check scripts are unchanged; `lib/typescript.js`
(the JS API) is gone, which nothing here imports, and knip ships its own TS 7. **`baseUrl` is
removed** — harmless, since `paths` were already relative and Vite defines the `@` alias itself.
It also found dead code 5.x accepted for years:
`(activeChatId ?? selectedChatId ?? undefined) ?? undefined`. That diagnostic was VERIFIED with an
isolated probe rather than trusted — as worded it would have implied a `number | null` atom read is
always null, i.e. a jotai/TS7 fault across hundreds of call sites instead of one redundant operator.

**Owed:** CI must resolve the **win32 and linux** TS 7 platform binaries (only darwin-arm64 is
proven), plus the usual Windows/Linux packaged pass.

**New warning to deal with before it becomes an error:** vite 8 prints
*"Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned
to become the default"* — `vitest.config.ts` uses ESM syntax while being loaded as CommonJS. Harmless
today, fatal when that default flips. Fix is a `.mjs` extension or `"type": "module"`; both touch how
every config in the repo is loaded, so it wants its own change rather than a drive-by.

### Electron 38 → 43 — what was actually true

Landed on **43.4.1** (Chromium 150, Node 24.18.1), not 42. The stated reason for the upgrade was
passkeys; the stronger one is that **38 and 40 are both EOL** — supported majors are 41/42/43 — so
we were shipping an unpatched Chromium. 43 also brings a Node startup snapshot for the main process
and V8 bytecode caching for preloads, for free.

**The old entry here was wrong in three places, and each error inflated the estimate. Corrected:**

- **There are not three ABI-pinned native modules; there is ONE.** `keytar` is not a dependency at
  all (credentials go through Electron `safeStorage`), and `@lydell/node-pty` is **N-API** —
  `nm` on the prebuilt `pty.node` shows `Napi::` symbols — so it is ABI-stable and never rebuilds.
  Only **better-sqlite3** does.
- **The OS sandbox helpers are NOT an Electron-ABI risk.** Both Rust crates are standalone `[[bin]]`
  executables; nothing links them to the Node ABI. They still need the Windows machine, for the
  v14.28.0 reasons, but not for this.
- **The `postinstall` landmine was already defused.** E42 stopped RUNNING the download from
  postinstall, but `install.js` still exists and is still the `install-electron` bin in 43.4.1, so
  `node node_modules/electron/install.js` works untouched. What did go is
  `ELECTRON_SKIP_BINARY_DOWNLOAD`, which we never used. **Do not touch `postinstall`** — the trailing
  `\|\| true` is still load-bearing for `patch-package`.

**What actually broke, in order:**

1. **`node-abi@3.77.0` does not know Electron 41, 42 or 43** — `getAbi` throws
   *"Could not detect abi for version 43.4.1"*, which is what `@electron/rebuild` surfaces. Fixed by
   refreshing the lockfile entry to **3.94.0**, still inside `@electron/rebuild`'s `^3.45.0` range.
   No `@electron/rebuild` major needed.
2. **better-sqlite3 12.4.1 does not COMPILE against V8 15** — 14 errors: `External::New` gained a
   required `ExternalPointerTypeTag`, `PropertyCallbackInfo<Value>::This()` was removed,
   `SetNativeDataProperty` became ambiguous. **12.11.1 builds clean** (verified: ABI 148), so the
   13.x major was avoided and drizzle compatibility never came into it.

**Trap for the next person: rebuilding in place breaks the test suite.** `@electron/rebuild` against
Electron writes ABI 148 into `node_modules`, and vitest runs under system Node — every DB test then
fails with a NODE_MODULE_VERSION mismatch. `npm rebuild better-sqlite3` restores the Node build. CI
never sees this because forge rebuilds the PACKAGED tree, not the repo's own `node_modules`.

**Also: the `@electron/rebuild` CLI is broken on Node 25** (yargs ESM interop). Irrelevant to CI —
forge calls the rebuild API, not the CLI — but it will waste ten minutes if you reach for
`npx @electron/rebuild` to debug.

**API breakage across 39→43: none.** No `clearStorageData({quotas})`, `showHiddenFiles`, `toBitmap`,
`--host-rules`, `createFromNamedImage`, offscreen rendering or `MimeHandlerView` detection. The E40
renderer-clipboard deprecation does not apply — every `clipboard` import is main-side.

**Two behaviour changes to confirm by hand, not fix:**
- E43 dialogs now default `defaultPath` to **Downloads** instead of last-used. We set no
  `defaultPath` anywhere, so this is purely the OS default changing under the clone dialog.
- E42 moved macOS notifications to `UNNotification`, which **requires code signing to display**.
  Signed releases are fine; an unsigned `npm start` silently shows none. Do not re-diagnose that as
  a regression.

### Passkeys — shipped, macOS only

`app.configureWebAuthn({ touchID })` in `main/webauthn.ts`, called as the FIRST thing INSIDE
`app.whenReady()`, plus the matching `keychain-access-groups` entitlement.

**THE TRAP, and it would have bricked every macOS launch.** Electron's docs say to call
`configureWebAuthn` "early (before showing notifications)", which reads as "before `whenReady`". Do
that and the process dies instantly with **SIGTRAP / exit 133** — `EXC_BREAKPOINT` on the main
thread, **no exception, no log line, nothing a JS `try/catch` can see**, so the app just fails to
start. "Early" means early WITHIN the ready phase. Proven both ways against a minimal Electron app:
before-ready exits 133 silently, after-ready returns cleanly. Nothing is lost by waiting — a browser
tab cannot request a credential until a window exists, which is necessarily after ready.

**THE SECOND TRAP, from the same feature and just as silent: the entitlement cannot go on every
binary.** `forge.config.ts`'s `optionsForFile` returned ONE entitlements file for every path
@electron/osx-sign visits, which includes nested helpers — ripgrep's `rg`, node-pty's
`spawn-helper`. Signing `rg` with a keychain access group it is not provisioned for produces a binary
that `codesign -v` calls **"valid on disk"** and that **"satisfies its Designated Requirement"**, and
that the kernel then **SIGKILLs on exec (exit 137)** with no output, no stderr and nothing in the
system log. `self-test:packaged` reported it as `ripgrep: FAIL`.

Split into two plists: `entitlements.mac.plist` (base + `keychain-access-groups`) for the TOP-LEVEL
bundle only, `entitlements.plist` (base) for everything else and for the inherit case. The selector
is `!filePath.includes(".app/")` — osx-sign's own test for the top-level bundle. **`endsWith(".app")`
would be wrong**, because a helper bundle ends with `.app` too. Signing a bundle applies its
entitlements to that bundle's main executable, which is the process that calls `configureWebAuthn`,
so the app gets the group and nothing else does.

**What a LOCAL package can and cannot prove here.** `forge.config.ts`'s `postPackage` hook ad-hoc
re-signs the whole bundle on non-CI darwin builds (`codesign --force --deep --sign -`), because
`packageAfterPrune` strips files after packager signs and would otherwise leave an invalid signature.
So a local build ends up `flags=0x2(adhoc)` with **no entitlements and no hardened runtime on the app
bundle** — meaning **passkeys cannot work on a local build no matter how correct the code is**, and
`configureWebAuthn` will report failure there. Do not read that as a bug. What IS verified locally is
the A/B on the helper: with the group on every file, `rg` was SIGKILLed; with it scoped away, `rg`
runs and carries only the base entitlements. The main app actually receiving the group is reasoned
from osx-sign's own top-level test and stays **unverified until a CI-signed build**.

**It was `self-test:packaged` that caught it**, and only because the call sat at module scope where
the self-test path reaches it. Note the corollary: now that the call lives inside `whenReady`, the
self-test **no longer exercises it at all** (`--self-test` runs its probes and exits without ever
reaching ready). So the packaged self-test can never again catch a regression here — that needs a
real launch, which is what the manual pass below is for. **The old entry's scope claim was wrong:** Electron's
docs are explicit that Touch ID credentials are **device-bound to the Secure Enclave and are NOT
synced through iCloud Keychain**. Release notes must say "Touch ID on this Mac", never "passkeys
sync".

- `select-webauthn-account` is a **Session** event, handled in `browser_view_manager`. One credential
  is answered directly; several **decline** with `callback(null)` rather than picking an identity for
  the user, and log it. A chooser is the follow-up if the log says it happens.
- Windows and Linux get `WEBAUTHN_NOTICE_SCRIPT`, which reports the attempt through the EXISTING
  `[[ATLARIX_ERR]]` console sentinel — no new IPC event, no reducer branch, no rendering. It does
  **not** reject the call: nothing can tell whether some future Electron would have satisfied it, and
  breaking a path that might work to report one that might not is a bad trade.
- **The bundle id is `com.electron.atlarix`** — @electron/packager's default, because `packagerConfig`
  never set `appBundleId`, confirmed against a packaged `Info.plist`. It is now baked into a signed
  entitlement and the keychain group holding users' passkeys. Kept deliberately; see the rename item
  under "Blocked on the owner".

### Dependency + security sweep

**54 production vulnerabilities → 28. Both criticals gone; 22 highs → 6.** Everything in-range plus
three deliberate moves; every MAJOR held for the `migration` branch.

- **`xlsx` replaced.** Abandoned on npm at 0.18.5 with unfixable prototype-pollution + ReDoS, and it
  parses attacker-supplied files. Now `read-excel-file` (.xlsx) + `papaparse` (CSV) — both read-only,
  both published within the last two weeks, 2.7 MB against 7.5 MB. **The CDN pin was never an
  option:** `verify-npm-lock-registry.mjs` hard-fails on any `resolved` URL outside registry.npmjs.org.
  Extraction moved out of `lib/tools/workspace.ts` into `lib/attachment-xlsx-extract.ts` with the
  other `attachment-*-extract` modules, so it can be tested without importing the tool registry, and
  the row/column capping both paths had duplicated is now one shared helper.
  - **Two real behaviour differences, both caught by the new tests, not by review.** papaparse's
    delimiter auto-detection is **wrong when `skipEmptyLines` is false** — a trailing newline (i.e.
    almost every CSV) skews the heuristic and a `;`/tab file parses as ONE column, silently, with
    `success: true`. Detection now runs as its own pass. And `Papa.unparse` **quotes** whitespace
    cells, so the old text-based `!csv.trim()` emptiness check stopped firing; it is now checked on
    the matrix. `newline: "\n"` is set because unparse defaults to CRLF and SheetJS emitted LF.
- **`drizzle-orm` 0.41 → 0.45.2** for the identifier-escaping advisory. Honest scope: our identifiers
  are static schema names, never user-controlled, so real exposure was low. **`drizzle-kit` stays at
  0.30.6** — no schema changed here. **Bump it before the next schema change**, or `db:generate` will
  be running against a mismatched pair.
- **`oxlint` 1.14 → 1.79** (CI gates on it) found one new error: a type declaration for
  `wink-bm25-text-search`, a package deleted in the retrieval teardown and imported by nothing.
  Deleted rather than patched.
- **Accepted, with reasons rather than a shrug.** `@huggingface/transformers` → `onnxruntime-node` →
  `adm-zip` → `sharp` has no fix and is the deliberately-pinned voice stack. `shepherd.js` →
  `deepmerge-ts` (stack exhaustion on recursive merges) needs a major; checked the call site rather
  than assuming — tour options are static literals in `TourManager.tsx`, so no attacker- or
  model-controlled object reaches the merge. Both revisit on the `migration` branch.
- **`patch-package` is down from four patches to two, and now runs CLEAN.** The `tr46` and
  `whatwg-url` patches only swapped Node's deprecated builtin `punycode` for the userland package;
  upstream has since done that itself (`tr46@6` requires `punycode/` natively, `whatwg-url@16` does
  not use it at all). They started FAILING rather than merely being redundant, because the `jsdom`
  update hoisted the new versions to the top of `node_modules` while the patches targeted 5.0.0 /
  0.0.3 — which now survive only as dev-only copies nested under forge's `node-fetch@2`, where the
  sole symptom is a deprecation warning at package time. Deleted rather than re-targeted at the
  nested path. The forge patch was also regenerated at 7.11.2 (content byte-identical) so its
  standing filename warning can no longer hide a real patch error — which is exactly how these two
  went unnoticed.
- CI `quality` and `headless` jobs were on **Node 20, EOL since April 2026**, while `engines.node` says
  `>=24`. Raised to 24. Build jobs stay 24/25 as they were — Node 25 still breaks better-sqlite3's
  `llvm-lib /LTCG:INCREMENTAL` on windows-latest.

### The two-directory memory bug, and the approval card that never rendered

Found while testing the packaged build: a turn hung ten minutes on an `edit_file` and only Stop
recovered it. Two independent defects, one explaining the other.

**Agent memory had a deadlock that guaranteed the first note went to the wrong place.** The absolute
store path is published in exactly ONE place — `loadMemoryMdSection` — which began
`if (!memory) return null`, and `readMemoryIndex` returns null when `notes.length === 0`. Meanwhile
`skills/guides/memory.md` tells the agent the directory is *"path shown in your context"*. So on a
workspace with no notes the context said nothing, the skill pointed at nothing, and the agent
invented `~/.atlarix/projects/<basename>/memory/` — the human-readable guess. Notes landed outside
the store, which kept the store empty, which kept the section hidden. **Self-perpetuating: the first
note could never be written correctly**, and every attempt sat outside the sandbox grant so it raised
an approval prompt too.

Confirmed on this machine — `projects/wisdom-drop/memory/` held three real notes while
`projects/Users-…-wisdom-drop-1upmb8f/memory/` (created by the app on 2026-08-04) was empty. **Not a
slug-scheme change:** `git log` shows the hash has been in `workspaceSlug` since `agent-memory.ts`
was born in v14.23.0, and `memoryDirFor` is the only code that builds those paths — the plain
directory was made by the agent with a shell `mkdir`.

Fixed at both ends: the empty state now names the absolute directory in one line (short on purpose —
this renders every turn), and `adoptMisplacedMemoryDir` moves stranded notes into the real store.
It **moves rather than copies**, which is also what closes the cross-contamination risk: two
workspaces can share a basename, and once the directory is claimed there is nothing left for a
second to adopt. Guards: never touch a store that already has notes; never adopt a directory stamped
for another workspace; **read the destination back and verify the count BEFORE deleting** — a partial
copy that removed its source would lose notes with no original left. A `.workspace` stamp makes
ownership a fact rather than an inference from then on.

**The approval card never rendered, and three registries shared the fault.** `permissionHandlers`,
`commandPermissionBlockedHandlers` and `filePermissionBlockedHandlers` were `Map<number, handler>` —
ONE slot per chat — while `InlinePermissionApprovals` is rendered **per assistant message**
(`AssistantMessageBody.tsx:653`). So a chat has as many subscribers as it has messages, and
`permission-request` has a second, unrelated one in `useStreamChat`. Two failures followed:
`set()` meant last-registration-wins, and the unsubscribe returned to an OLD registration did
`delete(chatId)` — removing whichever handler held the slot rather than its own, so an unmounting
message could leave the chat with **no handler at all**.

The main process was blameless throughout: it buffered, emitted and forwarded to every window. Note
also that `useStreamChat`'s handler filters `previews.filter(p => p.path)`, and a `sandbox_escalation`
preview carries `deniedPath`/`grantPath` but **no `path`** — the `path: 'N/A'` in the log — so even
holding the slot it renders nothing. Converted all three to `Map<number, Set<…>>` with a shared
`addChatSubscriber`/`notifyChatSubscribers` pair, copying `onTerminalOutput`, which has always had
the right shape in the same file. **`userQuestionHandlers` and `mcpConsentHandlers` deliberately
left alone** — one subscriber each, so no collision. **Four dispatch sites, not one:** the in-band
chat-stream path (`ipc_client.ts:458`) is easy to miss and delivers the same event.

### Two bugs found on the way, both silent-wrong-answer class

- **grep could not search four of our own source files.** A literal NUL byte used as a string
  separator (`web.ts`, `sessionAtoms.ts`, `useAttachments.ts`, `agentic-loop-repetition.ts`) makes
  ripgrep treat the file as binary. In a RECURSIVE search — the only kind this tool does — ripgrep
  **silently skips** such files; the `binary file matches` notice is only printed for files named
  explicitly on the command line. So grep answered "No matches" for every symbol in all four, and
  `git diff` showed three of them as `Bin` too, meaning code review could not see them either.
  Fixed at both ends: the separators are now written `\u0000`, and `grep` passes `--binary` and
  parses the notice into a flagged result instead of dropping it for having no `:<line>:`. **Do not
  re-introduce a raw NUL** — there is a comment at each site saying so.
- **Session messages could render out of order.** `session_messages.created_at` defaults to
  `unixepoch()` — **whole seconds** — and three queries in `workspace_session_handlers.ts` ordered on
  it with no tiebreak (or with `asc(id)`, a random UUID). Ties are therefore undefined, which meant a
  reload could show the assistant's reply ABOVE the question it answered; worse, the two DELETE paths
  (excess-trim and edit-rewind) sliced on that order, so a tie could delete the wrong message or
  leave a stale answer under an edited question. All three now tiebreak on SQLite's `rowid`, which is
  actual insertion order — `id` is deterministic but WRONG, and the new test pins that distinction.
  Surfaced as `stream-transport-contract.eval` flaking under load while passing in isolation.

**OWED before release:**
- [x] **Packaged-app pass on macOS — DONE.** `self-test:packaged` reports **9/9** including the new
      `sqlite` probe (`better-sqlite3 ok (sqlite 3.53.2, ABI 148)`), re-confirmed after each
      migration commit, and the app launches normally, so the SIGTRAP is gone.
- [ ] **A real passkey, on a CI-SIGNED build.** Still owed and NOT doable here: `postPackage`
      ad-hoc re-signs local darwin builds, which strips entitlements and hardened runtime, so
      `configureWebAuthn` fails locally BY DESIGN. Read `main.log` for `[webauthn] Touch ID
      configured` before blaming the site — a failure looks identical to the old bug.
- [ ] **Windows + Linux** — the same self-test, plus the passkey notice being **ACCURATE**, which is
      the real check now: it must NOT appear for a request that explicitly asks for a roaming
      authenticator, because a USB security key or a phone over hybrid/QR should simply WORK there.
      Verify one actually does. Only the PLATFORM authenticator is macOS-only. Batch with everything
      else already waiting on that machine.

---

### Previous release — v14.34.0, and the traps it left

**Command-output truncation was discarding 99% of its own budget.** `formatCommandOutput`'s
over-cap path emitted errors → warnings → FIRST 5 LINES → LAST 5 LINES: a **fixed ~13 lines / ~550
bytes regardless of `max_output_bytes`**, which defaults to 80,000. Measured on a 20k-line build
log: 13 lines before, **1,671 lines after** (100% of budget). It also REORDERED, so for anything
log-shaped the sequence — which is the information — was unreadable, and it never said how much it
dropped, so sampled and complete output looked identical. Observed consequence: a model declared the
output truncated and re-ran the command redirected to a temp file, costing two turns to recover
information that already fit. Now head+tail filled to the budget, in order, with an explicit
`omitted N line(s)` notice and error lines from the omitted middle appended as labelled excerpts.
**Two-pass fill** is required: the notice and the excerpt reservations depend on each other (holding
back room for excerpts shrinks the body, which grows the middle they come from).

**"Allow all" was a one-shot queue drain, which is not what anyone read it as.** It cleared what was
pending, the model issued its next command, and the prompt returned — so a research turn (`curl`,
then `python3`, then `jq`, each **dangerous on its FIRST TOKEN**) needed one click per command. And
"Always allow" cannot help there: for a danger match the key is `danger:<id>` and the label is "this
command", so it never generalises. Now `approve-all-for-turn` sets a blanket on the **per-turn
interceptor** — which is why it needs no expiry logic and cannot leak: the interceptor is never
reused, so the blanket dies with the turn. Set BEFORE draining, or an operation arriving mid-drain
re-raises the prompt. Inline "Approve all files" deliberately stays one-shot (a file batch is a
bounded, visible set).

**Workspace removal: the copy hedged across two different actions.** `delete-app` only `rm -rf`s the
folder for Atlarix-managed clone roots and leaves every other path alone — but every removal warned
about deletion conditions, so taking a project off the list read as though it might erase your code.
Split into two honest messages, both in an in-app `AlertDialog` (the native `window.confirm` reads as
an OS-level warning and blocks the renderer). **And the branch was broken on Windows:** the old test
was `appPath.includes("/Documents/Atlarix")`, which can never match a backslash path — so a managed
workspace on Windows got the REASSURING copy and then had its files deleted. Now matched on path
segments with either separator, case-insensitively.

**QA sub-agents — SHIPPED, the design's own "role, not a subsystem" test finally met.** Three
decisions collapsed it from a subsystem into a role, each recorded because each deletes a limb:

- **Findings are PROSE in a prescribed shape**, not a validated structured return. There is **no
  schema-validated model output anywhere in this repo** (v13 removed handoff schemas on purpose), so
  a parser + validator + re-prompt loop would have been the only genuinely new machinery in the
  batch — and the models likeliest to emit malformed JSON are the weak ones the contract exists for.
  It also needs **zero rendering**: a worker's final message already renders as markdown in the
  `SubAgentRunCard` dialog and via `buildDelegationView`. A JSON payload would be a raw blob in
  both, needing a new `ToolExpandView` kind + a `subagent_findings` event + a reducer branch.
  **Measure before building the validator** — script a weak model over a multi-item contract and
  count dropped items.
- **No `http_request` tool.** Its three justifications were: curl hands over the shell, a native
  tool returns structured evidence, it can be origin-bound. With the terminal granted and egress
  unrestricted, 1 and 3 are moot; 2 survives but a command's output is **harness-recorded**, not
  model-narrated, which is the property the contract needs. QA already reaches HTTP three ways.
- **No browser gate and no egress grant** — owner's call, treat it as a real agent. Recorded
  consequence: `browser_interact` has **no approval path at all** in any mode, so `DESIGN_NOTES`'s
  "destructive interactions go through the existing approval path" describes something that does not
  exist. And this is the first feature whose actions leave the machine, while our containment story
  is write-confinement, which says nothing about egress.

**The prerequisite was a channel, not a guard.** Sub-agents had no permission interceptor, which
reads as safety and was actually why they could not run commands: a worker with no way to ask is
either mute or unsupervised. They now borrow the interceptor of the turn that spawned them —
`getInterceptorForChat` — which is sound because a sub-agent runs strictly between
`registerInterceptor` and the turn's end and nothing ever unregisters. That inherits the card, the
danger gate, the OS sandbox, escalation-on-denial, the terminal tab and Stop-cancellation with
**zero new execution code**.

**The trap inside that:** borrowing the parent's interceptor inherits the parent's `turnWorkMode`, so
a QA worker spawned from a Build turn would have got **workspace-write**. Fixed with
`preview.readOnly`, a NARROWING-only per-request override. `enforce` is set for the caller-forced
case (so it fails rather than running unconfined) but **deliberately NOT for mode-driven read-only** —
that would newly refuse every Explore/Plan/Review command on a machine with no OS sandbox.

**`write:true` cannot turn a `qa` spawn into a writer** — `subagentWillWrite` returns
`agentIsWriter(agent)` for a NAMED agent and ignores the flag. Non-obvious, load-bearing, now pinned.

**A latent bug fixed on the way:** `resolveBrowserScope` falls back to the FOCUSED window then the
first window, and the delegation wrapper never injected `_ownerWindowId` — so a sub-agent's browser
calls silently drove whichever window the user was looking at, and retargeted mid-task if they
switched. Worse than an error, because nothing reported it.

**Plan title now reaches the MODEL** (`context-sections` ledger + both `readPlan` returns). Storing
the column fixed the panel and left the agent reading a scraped heading — so the half that mattered
on resume was still broken. **Delegation now marks plan steps** in_progress on hand-off, done on
accept.

**QA is NOT advertised in Plan mode**, deliberately: you plan before building, so there is nothing
running to test. Four advertising sites, not six.


**Per-turn work mode, plan titles, per-mode tool reveal.** Landed, full suite green
(360 files / 3021 tests), NOT yet verified in a packaged app.

- **A per-window decision was being made from GLOBAL state** — the exact mirror of the v14.32.0
  trap. `buildRunCommandSandbox` re-read `workModePreference` from the one global settings file,
  so a second window opening in Explore flipped a first window's in-flight Build turn to a
  read-only sandbox mid-command (`cannot lock ref 'HEAD' … Operation not permitted`). **Five
  sites, not one**; three of them also ignored `workModeOverride`, which gave unattended
  automations Build-mode gating. The turn's mode is now a constructor arg on
  `PermissionInterceptor` and the single source everywhere else.
- **The trigger was an effect, not a click.** `ChatIntentSelector.tsx:100-106` force-writes the
  global mode to `ask` whenever the chat chrome is read-only, so *merely opening a window* stomped
  it. And `settings_handlers` broadcasts nothing, so the first window kept displaying **Build**
  while running read-only — which is why it read as a git problem.
- **Plan titles are a stored column** (`0073_session_message_plan_title`). The old code spliced
  the title into the markdown only when the body did not start with `#` — true of `## Goal` — so
  the title was discarded for most models and the scraper returned the word "Goal". `title` is now
  required to CREATE a plan, enforced per-operation inside `writePlan` (the schema's `required`
  array is tool-wide and would have rejected every `read`/`update_step` call; property-level
  `required: true` hoists into that same array, so neither could work).
- **`title` was invisible to every weak model** — `simplifyToolParametersForProfile` keeps only
  the first THREE optional params, and `title` was fifth. Reordered to `content, title, planId`.
- **Per-mode tool reveal is back, tiering DESCRIPTIONS not tools.** v13 deleted the old reveal
  because 22 tools is a small surface — correct about the count, wrong about the cost: the
  descriptions were ~28k chars ≈ 7k tokens *every turn*. Measured saving now **1,700–2,150
  tokens/turn** per mode. Names and schemas always bind, so nothing is unreachable and nothing is
  lost to compaction; the full text arrives via `tool_help` as a tool RESULT, never in the tools
  array — **the tool definitions live inside the first prompt-cache breakpoint**, so growing them
  mid-session would invalidate the entire cached prefix. That constraint is what makes the tiering
  per-MODE rather than a ladder.
- **A pointer cannot replace a correction.** `capability-trim.eval` caught the tiering stripping
  `browser_inspect`'s anti-lure wording (v14.8.9, added for an OBSERVED bug). A model about to make
  the mistake does not know to call `tool_help` first — so descriptions that steer AWAY from a
  known failure are now in a documented `NEVER_TRIM` set. Add to it only with that justification.
- Also: guard now logs both `INVALID_PARAMS` paths (three failed `edit_file` calls left NO trace);
  `proposals` resolves an id missing its `prop_` prefix; `update_step` tolerates trailing junk on
  `step_text` (narrower than falling back to `step_index`, which would tick the WRONG step — an
  existing test correctly pinned that and was kept); `toolset-golden` now covers `debug`/`review`.
- **Dead code removed:** `getEffectiveChatMode` (0 callers, and its "read settings live" comment
  was the pattern that caused the bug), `getOptionalWorkspaceTools`, `plans:create`,
  `plans:list-by-session`, `plans:append-step` + its client method, the Plan panel's *Add step* and
  *Mark built* buttons. The `mode-prompt-bundle` prompt that told Build mode it had "all workspace
  tools via progressive reveal" was a **live falsehood** since v13 — now describes what happens.

**OWED before release:**
- [x] **Packaged-app pass — DONE by the owner before the v14.34.0 tag.** The two-window repro, a
      plan from a `## Goal` model, the weak-model `title` check and a real QA run were all exercised
      by hand in the packaged app. Recorded because the two prior releases were verified the same way
      and this project treats "self-test passed" and "someone used it" as different claims.
- [ ] **Measure contract drift** — script a weak model over a multi-item coverage contract in
      `tests/agent-evals` and count dropped items. That number, not reasoning, decides whether the
      validated structured return ever gets built.
- [ ] **Run the session-load diagnostic** — `ATLARIX_DIAG_SESSION_LOAD=1` (main) +
      `localStorage["atlarix:diag:session-load"]="1"` (renderer), open the 1.43M-token session,
      record the four numbers here. Ruled out already: NOT summarisation (zero compaction events in
      13h of log) and NOT tiktoken (memoised + delta-cached). Prime suspect is
      `workspace_session_handlers.ts:751` — `parseDisplaySnapshot` per row on the main thread, over
      a synchronous select with `SESSION_LOAD_MESSAGE_LIMIT = 100_000`. **A loading screen alone
      cannot fix it**: the overlay exists and cannot paint because nothing yields.
- [ ] Confirm `[prompt-cache]` still shows large `read=` on later turns in a mode. A `write=` that
      jumps every turn would mean the tiering is invalidating the prefix.

---

### Previous release — traps worth keeping

**v14.33.0 SHIPPED 2026-08-17** — automations that actually tell the agent, plus
`operation:"run"`. 12 assets, both update feeds, MSIX submitted. Both fixes verified by hand in
the packaged app before release.

**It shipped as a DRAFT first.** `publish-release` PATCHed `draft:false` with a bare
`curl -sS`, which exits 0 on an HTTP error — GitHub 503'd mid-incident, the step went green,
every job went green, and the release sat unpublished with all 12 assets attached. Published by
hand; the step now retries and READS THE RELEASE BACK before passing. Third instance in one day of
the same class: **a step that reads as success while the thing did not happen.**

**Then it published but was not `latest`.** Draft cleared, 12 assets attached — and
`/releases/latest` still resolved to v14.32.0, so the launchpad, the download redirect and the
auto-updater all went on serving the previous version. GitHub picks latest by **`created_at`**,
and `atlarix-releases` is a release host with ONE commit — every tag points at it, so every
release ties on `created_at` (`2026-07-26T19:32:39Z`) and the tie never broke forward.
Fixed with `make_latest` on the publish PATCH plus a read-back against `/releases/latest`
itself. **Publishing is not the last thing that has to be true — being latest is.**

**Two previously-unverified fixes are now confirmed:** notes written at creation (body came back
1,820 chars, not the ~560 placeholder) and the regenerated `RELEASES_TOKEN` (headless resolved
the release AND an asset id; `headless-bench` serves 14.33.0 again).

---

## 🚧 Needs the Windows machine

**Every fix below is ALREADY SHIPPED.** This section is one session's verification checklist, not a
backlog — `taskkill /T` is in `runShellCommand.ts:311`, the notification hold-until-`close`/`failed`
in `desktop-notification.ts:81`, the Low-IL sandbox in `native/atlarix-sandbox/`, voice q4 since
v14.30.0. Counting these lines as open tasks is what made this queue read three times its real size.
Grouped so a single trip clears them all.

**The Electron 43 release is now the reason to book this session** (see In flight, top). Its
Windows-side asks are: `self-test:packaged` reporting **9 probes** including the new `sqlite` one
(the only genuinely ABI-pinned module, and the one nothing used to cover), and a passkey site
showing the NOTICE instead of hanging. Note the correction — the upgrade does **not** revalidate the
sandbox helpers, which are standalone Rust binaries with no Node ABI coupling; those need this
machine for the v14.28.0 reasons listed below, which is still the same trip.

### v14.31.0 — the notification crash (LINUX, not Windows)
- [ ] `SIGSEGV` in `electron::NotificationPresenter::RemoveNotification` — a Sentry report from
      Fedora 44, fixed by holding each `Notification` until `close`/`failed` instead of dropping the
      reference at `show()`. **The fix is reasoned, not observed**: it reproduces only on Linux, and
      only as a race against the notification daemon's own teardown.
- [ ] Confirm by leaving the app unfocused through several automation runs and turn-done
      notifications, letting each expire on its own rather than clicking it. Success is the absence
      of a crash and a clean Sentry week; failure would be another minidump on the same frame.

### v14.30.0 — on-device voice on the CPU path
- [ ] Install the release and dictate. **Success is the log**
      (`%APPDATA%\Atlarix\logs\main.log`): `loading onnx-community/whisper-small on … (dtype=q4)`,
      then `model ready on device=webgpu` **or** `device=wasm` — **either is a pass**, and `wasm` is
      the more valuable result because that is the path that was broken. Then `transcript(N chars)`.
- [ ] **Must NOT appear:** `MatMulNBits`, `Missing required scale`, `stopped downloading`.
- [ ] Download is ~285 MB (not ~800 MB); the mic is **clickable while it downloads**.
- [ ] Same on Linux, never tested, now on the same WebGPU-first path.

### Windows sandbox (Low IL) — from the v14.28.0 rebuild
- [ ] `run_command` must succeed with git under Low IL. **This is the whole point.**
- [ ] `--self-test` → **9 probes** (was 8 before the `sqlite` probe) including `sandbox`; confirm an **info**-level
      `Sandboxing run_command` line (it was `debug`, so only failure was ever visible).
- [ ] `CreateProcessAsUserW` succeeds unprivileged. `ERROR_PRIVILEGE_NOT_HELD (1314)` means the
      probe reports the sandbox unusable and commands run unconfined — then implement Codex's model.

### v14.32.0 — the process-tree kill on Windows
- [ ] `taskkill /pid <pid> /T /F` replaces the SIGTERM-to-direct-child that left grandchildren
      running. **Reasoned from documented behaviour, not observed** — same posture as the v14.31.0
      notification fix. macOS/Linux are covered by a real-process test
      (`src/__tests__/kill-process-tree.test.ts`), which is skipped on Windows.
- [ ] Confirm: start a dev server through `run_command`, cancel it, then check Task Manager /
      `netstat` that no node process survives and the port is free. Failure looks like a port still
      held after the UI says the command stopped.

### MSIX / Store build
- [ ] Run the §4 behaviour check (`docs/MSIX_RUNBOOK.md`). **Baseline on Squirrel FIRST** — a failure
      inside MSIX is otherwise unattributable. Not to be confused with the packaging spike, which RAN
      on 2026-08-07 (`497cf5c9` built the probes, `14a53900` removed the dead code they found); §4 is
      the deep-system behaviour inside a real package container, and only real Windows can run it.
- [x] **A Squirrel → Store reinstall keeps the user's data** — verified by hand 2026-08-12.
      `userData` does not diverge in the package container, so **no migration is needed** and it is
      safe to tell users to reinstall from the Store (the 2026-08 outreach email does). Checked
      manually, so the exact path string is still unrecorded — the one remaining piece.
- [ ] Manifest protocol declaration works (OAuth sign-in) and `atlarix://pro-return` completes a
      Lemon Squeezy purchase.

---

## 🧭 Designed — awaiting a session

- [x] **A plan switcher in the Plan panel — DONE.** Handler `plans:list-by-session` (a ten-line
      wrapper: `listPlanArtifactsForSession` already existed, contrary to both the original claim and
      its correction) plus the picker, which only renders when a session has more than one plan.
      **The pin was the actual work.** Plan-artifact ACTIVATION replaces whatever the panel shows, so
      without `pinnedPlanId` choosing an older plan and then having the agent touch a different one
      yanked the panel away mid-read — the select would still read one plan's name while the body had
      become another's. Activation now only raises the unread badge while pinned; "Latest" unpins.
      `onUpdated` needed no guard, it already ignored other planIds.

Full reasoning in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md) — including the ban system's scope
decision (why BYOK and local models are deliberately outside it), recorded because that will be
re-litigated. One line each so this file stays a queue, not a design doc.

- **QA sub-agents** — up to 3 declared *surfaces* (web/api/mobile/mcp/cli) that exercise the running
  app and report evidence-backed findings. Gets the requirement, **not the diff** — independence of
  judgment is the point. A scoped `http_request`, not the terminal. Load testing is an explicit
  non-goal. **Settled 2026-08-17:** coverage workers (QA, implementer) get an enumerated contract in
  the spawn payload and return one validated entry per item — no check-off tool, because self-report
  is unverifiable exactly on the weak models it would be added for.
- **Smaller upstream-review items — AUDITED 2026-08-17, four of ten were real.** Native PDF parts,
  the orphaned-grandchildren half of `run_command` containment, malformed tool-arg handling and the
  `read_url` cache all shipped in v14.32.0. **Deleted:** approval notifications (already shipped —
  `permissions/handlers.ts:134`). **Shrunk:** `llama-server` is now only about llama-server, since
  Ollama and LM Studio already resolve their real context windows via
  `resolve-model-context-limit.ts`; nested-repo trust is prompt-injection weight only, because hooks
  were deleted and no `.atlarix` file is shell-executed any more. What remains:
  - **`run_command` memory/CPU containment** (cgroups / Job Objects). The orphan half is done; this
    is the runaway-build half, and no observed failure yet.
  - **`llama-server` `/props`** for the true `n_ctx` and chat template. Reachable today as a custom
    OpenAI-compatible endpoint, just falling back to heuristics — one provider, not a systemic bug.
  - **Nested-repo trust on mid-session clones** — does a repo cloned mid-session re-trigger
    authority-file approval? Prompt injection, not RCE.
- **DROPPED 2026-08-19 — no evidence, no observed failure.** Per-model sampling defaults (the
  `getTemperature` hook already exists; populating it needs a model we can show is hurt by
  `temperature: 0`, which we do not have) and the Windows path-validation matrix (scar tissue, but
  no exploitable path, and writing it "may find nothing" by its own admission). Both said outright
  they were not ready; carrying them made the queue longer without making it truer. Recover from
  git if evidence ever appears.
- **Chore-model routing stays OPT-IN.** `lib/summarization_model.ts` already offers
  `"same"` (default) or `"custom"`, and titles + compaction both route through it. Defaulting Core
  users to Core 1 would silently change what they are paying for; left as the user's explicit choice.

### Owner-requested 2026-08-19 — ALL THREE DONE

- [x] **`automations` create hands back its id.** `preview.automationId` is set at execute time (the
      `verified` precedent), reported from `getExecutionResult`'s `automation_write` branch, and
      carried through BOTH turn branches — ask-branch included, or Ask mode would have been silently
      left behind. The permission envelope was never the obstacle; that channel already existed.
- [x] **`plan({ title })` resolves.** Addresses a plan on every op except `write`, where `title` keeps
      its create-name meaning (making it an addressing key there too would be genuinely ambiguous).
      Reusing `title` rather than adding a param was forced by
      `simplifyToolParametersForProfile`, which keeps only the first THREE optional properties — a new
      field would have been invisible to exactly the models that drop ids. Duplicate titles fail
      loudly with both ids. A stale title differs by op on purpose: a read says the title is unknown
      and lists the session's plans; a mutation falls through to the in-flight plan.
- [x] **Ban system.** Scope: Core spend + the account; BYOK and local models are NOT blocked and the
      UI says so. Hard stop is the proxy's 403 `account_banned`, folded into `get_credit_balance` so
      it rides the wallet read and inherits balance-cache's 3s TTL. Reason lives in
      `public.user_bans` (RLS on, no `authenticated` policy) because `users` rows are pushed to the
      client by realtime. `guard_users_sensitive_columns` now raises on `banned_at`. Client guard is
      in the IPC HANDLER, never `useAuth`. `docs/BAN_RUNBOOK.md` has the SQL.
      **APPLIED to production 2026-08-20** (`supabase db push`; it was the only unapplied migration).
      Verified after: `banned_at` present and null, the owner's row still reads `pro/pro`, an anon
      INSERT into `user_bans` is refused `42501`, and `get_credit_balance()` still executes cleanly
      (`not_authenticated` with no JWT) — so replacing that hot-path RPC broke nothing.
      **The migration was WRONG when written, and applying it as drafted would have caused an
      outage** — see the section below. **Still owed:** the authenticated deny-path check from
      `docs/BAN_RUNBOOK.md`, which needs a signed-in test user (a service-role probe cannot stand in,
      because `service_role` is exactly the branch that bypasses the guard).

## ⏳ Open / deferred

- **OWED from v14.31.0: the packaged-app pass on Console + Network.** Everything below the UI was
  verified — full suite, and an integration run of the real capture module against youtube.com in
  Electron 38 (43 rows, all identified; bodies 8/8 on demand; youtube → github grew the log 43 → 105
  instead of clearing it; clean detach and tab close). **The two panels themselves have only been
  reasoned about.** Reproduce the original report exactly: open YouTube, confirm the signed-out 401
  appears in Network and does **not** block the turn; navigate to GitHub and confirm a divider plus
  two distinct cards; expand a row and pull a body; confirm a page logging in a loop neither stalls
  the UI nor floods it; confirm the app window's own DevTools still opens.
- [x] **The CSP now reaches the whisper worker — code done, packaged check owed.** A dedicated worker
      does not inherit its owner document's policy; it takes one from its OWN script response, and the
      handler matched only `mainFrame`/`subFrame`, so `whisper-worker` ran with no policy and `eval()`
      was free inside it — while the docstring claimed A13/M-6 coverage. Electron's WebRequest has no
      `worker` resourceType, so the predicate now also matches `script`/`other` on `file://`. That is
      safe rather than broad: a CSP header on an ordinary subresource script response is IGNORED —
      only documents and worker scripts honour their own — so it changes behaviour for workers and
      nothing else. `'wasm-unsafe-eval'` stays, because it is what lets onnxruntime-web compile.
      Predicate extracted to `main/csp-policy-target.ts` and tested.
      **MEASURED on a packaged build, 2026-08-19** (`ATLARIX_DEBUG_CSP=1`): `file://` scripts report
      `resourceType=script` (5 stamped on boot) and the document reports `mainFrame`; `stylesheet`,
      `font` and `media` are correctly skipped. The app booted and rendered with those 5 scripts
      stamped and **zero CSP violations or errors**, which is the empirical form of the claim above —
      a CSP header on an ordinary subresource script is ignored, or the app would not have started.
      **STILL OWED, one click:** the whisper worker only spawns when a composer MOUNTS with the local
      provider, so it needs a workspace open. The probe account is free-tier and already at its
      1-workspace limit (`PlanLimitError`), so the worker never loaded. Open an existing workspace in
      the packaged app, confirm dictation still transcribes, and check the log for a
      `[csp] APPLY resourceType=script … whisper-worker` line. If ONNX fails to compile, revert to
      docstring-only — a blocked worker that also blocks WASM is worse than the gap.

- **Configurable read-deny patterns, opencode-style** — user-declared only
  (`read: { "<pattern>": "ask" | "allow" | "deny" }`), no defaults; chosen over Codex's model
  because it keeps `lib/tools/glob.ts:221` intact — that line records the deliberate decision that
  *"in-workspace files (incl. .env) are enumerable"*. **The caveat dominates the estimate:** a
  deny-read is only real if `run_command` can't `cat` the file. macOS Seatbelt and Linux Landlock
  are both cheap; **Windows Low IL cannot** — MIC is `NO_WRITE_UP`, so reads up are allowed by
  design, and the AppContainer that *could* deny reads is exactly why it broke. Scope as tool-level
  everywhere + sandbox-level on macOS/Linux + a documented Windows gap.
- **Packaging registry (deliberately deferred).** `runNpmInstall` (`forge.config.ts`) spawns npm
  with no `--registry`, in `buildPath` outside the project, so a custom global registry wins and
  `packageAfterPrune` dies with `E401`. Until it lands, `npm run package` needs
  `npm_config_registry=https://registry.npmjs.org/`. Held pending the owner's account migration.
- **Sub-agent results still don't *continue* in the timeline** — STILL OPEN, deliberately not
  attempted. Results now RENDER properly; what remains is purely placement (they sit in round-panel
  cards behind the expand affordance rather than resolving inline). Direction: weave settled
  `subagent` items via `weaveIpcItemsIntoParts` (`WEAVABLE_KINDS` excludes `subagent_round`) and
  collapse the panel once all agents settle. **Why it keeps being skipped:** its entire value is
  visual placement, in the most reflow-sensitive code in the renderer — `AssistantMessageBody`'s
  sticky-agents / seam-offset / synthesized-round interaction, which already produced one "scratchy
  rendering" regression. Land it in a session that starts with the packaged app open.

### Checked and CORRECT as-is — do not "fix" these

From the 2026-08-05 hardcoding sweep. The test in every case is *what happens when the list is
incomplete*; the reasoning is in git.

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

---

## ⚙️ Actions storage — the second billing trap

**2026-08-17: Actions storage hit 100% (0.5 GB account allowance).** Different failure from the
2026-08 billing block, and it does not look like one — there is no dead workflow, just an email.

**Cause, measured not guessed:** all nine live artifacts were `atlarix-msix-x64`, 163–326 MB each,
at **14-day** retention — 2.2 GB total. Nothing downloads that artifact: **Store submission is
automated and reliable**, running in the same job straight from `out/msix/`.

**Fix:** the upload is now CONDITIONAL — `workflow_dispatch` (where nothing submits, so the
artifact is the deliverable) **or** `steps.store_submit.outcome == 'failure'` (where it becomes the
only copy of an already-built package, since submission is `continue-on-error`). In the normal case
a tag now uploads **nothing**. Retention 14 → 2 days for when it does. The upload step had to move
*after* submission to read its outcome, and the submit step gained `id: store_submit`.

**The diagnostic**, which is worth keeping because the email doesn't tell you what filled it:
```
gh api "repos/AmariahAK/Atlarix/actions/artifacts?per_page=100" \
  --jq '.artifacts[] | select(.expired==false) | "\((.size_in_bytes/1048576)|floor) MB  \(.name)"' | sort -rn
```
- [x] **DONE — verified 2026-08-19 against the live API: 1 artifact, 0.00 GB.** `5e6f4f8c` cut
  retention 14d → 2d and `dc39de61` uploads the MSIX only when it would be used, so the backlog
  aged out on its own; no manual deletion was needed.
- Rule of thumb: an artifact nothing DOWNLOADS is a convenience copy, and its retention should be
  days, not weeks. `landlock-helper` is the counter-example — it IS consumed, and is already 1 day.

## 🌐 Core web search + `read_url` — SHIPPED v14.35.0, one item left

Measured 2026-08-19: browser tier **24 / 29 / 25** results on three developer queries where DDG and
all five public SearxNG instances returned **0 / 0 / 0** — the lower tiers had not degraded, they
returned nothing. Docker auto-setup and the public tier deleted (~980 LOC); self-hosted SearxNG and
DDG kept because headless stubs Electron and would otherwise have no search at all. `read_url` now
fetches first and renders only on failure. Full narrative in `CHANGELOG.md`; the traps that must not
be re-learned are in the shipped index at the foot of this file.

- [ ] Exercise `read_url` through the **packaged app's own tool** against a JS-rendered SPA and a
      bot-walled page. The mechanism itself is already measured (2026-08-19, under Electron against
      real sites: excalidraw 69 → 722 chars, g2.com 0 → 251, react.dev and sqliteonline unchanged and
      never rendered, five parallel fetches 624ms) — what is untested is the path through a real turn.

## 🔜 Blocked on the owner — NOT active work

- **Windows code-signing / cert** — C6 auto-update signing + native-sandbox CI (release-infra, no
  cert). OAuth `state` nonce / PKCE stays **not doing** (attempted v14.12.0, broke sign-in,
  reverted; the flow-in-progress gate stays).
- **Dependency deprecation triage** — ~~scheduled~~ **DONE and merged** (see the `migration` branch
  section above); kept here only for the reasoning, which still applies to the next such batch: Electron 43 and the spec-line majors both rewrite
  `package-lock.json`, and a lockfile conflict is not hand-mergeable — you regenerate, which
  re-resolves everything and invalidates the verification on both sides. Four independently
  revertable commits so a bad one costs that commit, not the branch: (1) `ai@6→7` + the 11 provider
  packages (v3→v4 spec) **with zod 3→4 as one unit** — tool schemas are the coupling; (2) `vite` 5→8
  + `@vitejs/plugin-react` 6; (3) `vitest` 3→4 + happy-dom 20; (4) TypeScript 5.9→7, the likeliest to
  drop since its payoff is compile speed, not capability. Also pick up `shepherd.js` 14→15 there.
- **Rename the macOS bundle identifier — its own release, and NOT a rider.** It ships as
  `com.electron.atlarix`, @electron/packager's default (`packagerConfig` never set `appBundleId`),
  and passkeys have now baked it into a signed `keychain-access-groups` entitlement. **The risk is
  why it is separate:** macOS ties `safeStorage`'s keychain ACL to the app's designated requirement,
  which includes the bundle id — so a rename can leave every user's stored provider keys and Supabase
  session undecryptable, which is exactly the failure v14.27.0 was about. It also resets TCC
  folder-access grants and orphans the Launch Services `atlarix://` registration. What is NOT at risk:
  `~/Library/Application Support/Atlarix` is keyed on the app NAME, so chats and workspaces survive.
  Needs a safeStorage re-encryption migration and an upgrade-in-place test on a signed build. Cost of
  waiting is one round of passkey re-registration for early adopters.

---

## 🔐 Security follow-ups (owner-triaged, from `docs/SECURITY_REVIEW_v14.8.12.md`)

Fixed by v14.8.13: compound-command danger gate, exfil taxonomy, deep-link auth-CSRF + pro-return
confirmation, MCP consent gate, `.atlarix` authority-file approval, MCP description wrapping +
OAuth-URL validation, the **universal write-confining sandbox** (Windows since rebuilt on Low IL,
v14.28.0), and the **system-scope approval gate** (which also closed M1). **Deferred:**

- **C6 — auto-update signature verification (Windows/Linux).** Highest blast radius, but
  release-infra (signing certs + `app-update.yml` for NsisUpdater; out-of-band signature for
  AppImage), not app code. Owner chose NOT to gate the public release on it; the Windows helper
  sign step is wired — set the cert secret to enable.
- **Native sandbox validation in CI.** The Windows/Linux helpers can't compile on macOS.
  `npm run check:sandbox` cross-target type-checks both and the helpers are gated on behaviour, but
  neither substitutes for running them on the real OS.
- **Unattended read-only allowlist-flip** (positive allowlist for Automation runs) — the denylist
  taxonomy is done; the flip needs per-automation design to not break legit builds/tests.
- **Round-tripped auth `state` nonce** — needs confirming the Supabase redirect-URL allowlist
  permits a query param (current gate = flow-must-be-in-progress).
- Sandbox **read**-confinement (Windows blocker in the read-deny entry above), **egress** gating,
  and the remaining Mediums (env-var key inheritance, secret-basename list, cross-workspace file
  scope, plaintext-keychain fallback).

---

## 🧮 The plan ledger went stale at the ROUND boundary — found and FIXED 2026-08-20

The fourth and last of the plan-tracking bugs, and the one the owner actually reported: **"the
notifications were wrong saying it did 1/6"**.

`markPlanLedgerDirty` / `takeRefreshedPlanLedger` was a take-once queue, which fixed later **steps**
but not later **rounds**. `run-agent-turn` re-enters the stream once per agentic round — completion-gate
nudge, stall resume, stream continuation — and each round is a fresh `streamText`, so `prepareStep` sees
`stepNumber === 0` again. That branch used the frozen turn-start `taskLedgerBlock` unconditionally, and
the queue had already been drained by an earlier step, so there was nothing left to override it with.
The two `buildContinuationPrompt` call sites had the same shape.

Observed in the log: a turn that began at 1/6 marked steps 1–3 done, hit the gate, and was handed
`[Session plan] 1/6 steps done` again on the next round. The model read that as the plan having been
reset, abandoned `update_step`, and rewrote the whole plan to force agreement — **exactly the loop the
refresh module exists to prevent**, arriving through the round boundary instead of the step boundary.

Fix: the newest rendered block is now sticky for the turn and served at every round boundary
(`currentPlanLedger`), while the take-once flag still governs mid-round steps so an unchanged ledger is
not restated every step. The stickiness is turn-scoped by `clearPlanLedgerRefresh` in stream preflight
— which had **no production caller at all** before this, so the map also leaked an entry per chat.
6 new tests, verified sensitive: reverting to take-once fails exactly the two round-boundary ones.

**A diagnostic trap worth keeping.** The neighbouring log line read
`Plan not complete — nudge 1/6; continuing`, where `1/6` is the *nudge budget* (`gateStreak+1/gateCap`)
and `gateCap` happens to be 6. Next to a 6-step plan that is indistinguishable from a step count, and
it cost real time to separate. It now reads `nudge 1 of 6 allowed`.

## 💥 The ban migration would have broken every client write to `users` — caught 2026-08-20

Found while applying it, by diffing the body against the migration history instead of trusting the
snapshot it was copied from. **`supabase/audit/prod_schema.sql` is STALE** — it predates
`20260714130000_pricing_reframe_teardown.sql`, which **dropped `public.team_members`, `public.teams`,
`users.team_id` and `users.has_db_studio_legacy`**. The drafted
`guard_users_sensitive_columns()` body referenced all four.

Why it would have shipped green: **plpgsql resolves record fields at RUNTIME, not at definition
time.** `CREATE OR REPLACE` succeeds, the migration reports success, and then the FIRST authenticated
`UPDATE` on `public.users` raises `record "new" has no field "has_db_studio_legacy"`. Every client
write to that table, from a migration that applied cleanly.

Three corrections, all landed:

1. The guard body is now taken from **the newest migration that defines it** (`20260714130000`) plus
   the one `banned_at` clause. The migration's own comment previously said to copy from
   `prod_schema.sql`; that instruction was the cause, and it is now reversed in both the migration
   and `docs/BAN_RUNBOOK.md`.
2. **`scripts/verify-ban-guard.mjs` was verifying a fiction.** Its scratch `users` table invented
   `team_id` and `has_db_studio_legacy` and created a `team_members` table, so it passed a body that
   could not run in production. **A fixture more generous than production verifies nothing.** The
   column list now mirrors the live table, and the check was confirmed to FAIL on exactly this
   (`record "new" has no field …`) before being restored.
3. `prod_schema.sql` is not regenerable here (`supabase db dump` needs Docker). Treat it as an
   archived snapshot, never as the source of truth for a `CREATE OR REPLACE` body.

**The general rule:** the source of truth for a replaced function is the newest MIGRATION that
defines it. An audit snapshot, a docstring, or an older migration will each silently revert whatever
came after it — and for a plpgsql body the revert is invisible until a real row goes through.

## ⚠️ `withLock` serialises TWO callers, not N — found 2026-08-20, NOT fixed

`src/ipc/utils/lock_utils.ts` awaits only the ONE lock it observed:

```ts
const existingLock = locks.get(lockId);
if (existingLock) await existingLock;
const { release } = acquireLock(lockId);   // both waiters reach here together
```

With three contenders, B and C both await A's promise, both wake when A releases,
and **both acquire** — C's `locks.set` simply overwrites B's. So it is a
"wait for the one in flight" helper, correct for two callers and silently not a
mutex beyond that.

Found while fixing the plan lost-update race, which is why plan writes use their
own FIFO chain (`withPlanArtifactLock`) rather than this. **Not changed here**: its
callers are app lifecycle paths (`app_handlers`) and altering shared locking
semantics deserves its own pass with its own verification, not a rider on a plan
fix. Whether those paths ever see three concurrent callers is the open question —
if they do, they have the same lost-update shape.

## 🔎 Found while probing the packaged build (2026-08-19) — NOT fixed, both pre-existing

Surfaced by a Sentry issue that turned out to be self-inflicted (a `pkill` + relaunch collided a boot
with a shutdown in one process, via the single-instance handoff). The collision was mine; these two are
not:

- **A `DatabaseClosingError` escapes as an unhandled rejection.** Three boot tasks caught it and logged
  "non-fatal" — the `db-closing-guard` doing its job. One left a floating promise, so it reached Sentry
  as `onunhandledrejection`, `handled = no`, and paged the owner. The guard is right; one boot task
  needs a `.catch`. Any user who quits during startup activity can hit it.
- **Local packaged builds report `environment=production` to Sentry.** A `npm run package` + launch on
  a developer machine fires high-priority production alerts on the `atlarix` project — which is exactly
  what happened. `app.isPackaged` is true for a local ad-hoc build, so it is the wrong discriminator
  for "production". Worth gating the DSN on something else (a CI-injected marker, or the signing
  identity) so developer runs stop polluting the signal.

## 📋 Carried / small

- **The "five unused dependencies" are really two — AUDITED 2026-08-20.** knip reports five because
  no source file `import`s them, and for three of them that is a **false positive by construction**:
  - **`axios`, `bluebird`, `@mixmark-io/domino` — MUST STAY.** They are listed in
    `mainRollupExternals` (`vite.main.config.mts:105-107`) because Rollup leaves them as bare
    `require()`s in the main bundle (transitive requires from `posthog-node` and `turndown`), and the
    `package.json` entry is what makes `packageAfterPrune`'s slimming (`keepRoots ∩ fullDeps`) keep
    them. Removing the entry ships a packaged app that **crashes at boot with "Cannot find module"** —
    the comment above that list records having already been bitten by exactly this. On top of it,
    `axios`'s direct range is what drags `posthog-node`'s copy up to the patched 1.19.0, so deleting
    it could resolve BELOW the SSRF fix.
  - **`@types/node-cron` — removable.** `node-cron@4` ships its own types
    (`"types": "./dist/node-cron.d.ts"`), so the `@types` package is a dead v3 stub. devDep, zero risk.
  - **`ignore` — removable.** Nothing imports it, it is not a main external, and `isomorphic-git`
    carries its own `ignore@5` in a separate tree, so dropping our `ignore@7` root cannot lower it.
    Added in the fork era (`e900b590`, v5.0.0).

  The lesson generalises: on this project "nothing imports it" is not the same as "nothing needs it",
  because the packaging pipeline requires bare-`require()` runtime deps to be declared. Check
  `mainRollupExternals` before believing knip.

- **CLOSED — fork sub-agents. The arithmetic does not work; do not re-propose.** A cache read is
  ~0.1× base input, but the inherited prefix is re-sent on **every step** of the worker's loop, not
  just the first — so an 8-step fork pays ~8× the discount it was supposed to save, for context it
  never asked for. It only breaks even for a very short worker, which is the case where the parent
  should not have delegated at all. Separately, the cache hit requires sharing the parent's toolset,
  which hands the least-supervised worker the full write surface. The real problem it targeted —
  workers re-deriving what the parent knows — is answered by **pointers, not payloads**: prompt and
  tool-description work pushing the parent to hand over the `file:line` facts it already has. Full
  reasoning in [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- **CLOSED — model-context secret redaction. Decided twice; do not re-propose.** Rejected in
  v14.12.0 (owner trusts the agent and the provider with credentials) and again **2026-08-17** on
  the reframed version. The reframe argued that because we hold the user's real secret *values*,
  exact-string redaction is zero-false-positive. That is true and still not sufficient: **no list
  caters for every form a secret takes**, and the tier-2 vendor-prefix set is exactly the kind of
  hardcoded list this project has repeatedly decided against — it would be wrong at the edges,
  need maintaining forever, and give the impression of a guarantee it cannot make. Display-side
  and telemetry-side redaction (Sentry `beforeSend`, git-stderr credential stripping) are a
  different concern and stay.
- **CONSIDER (evaluated → CLOSED): `browser-use`.** Python/Playwright (bad Electron fit), its own
  agent loop, and its one good idea (stable element refs) we already have via `browser_inspect`
  snapshot `ref`s. No capability gap.
- **CONSIDER (evaluated → REFERENCE ONLY): `h5i`** — a peer harness, not a library, and its leverage
  is Linux, which we already ship natively. Worth borrowing its `supervised` tier (egress
  allowlist), a capability we lack; see [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- **No test measures whether our own suite is sensitive** — no mutation testing, no eval where the
  fixture's suite is deliberately wrong, so "tests pass" is a claim about the suite, not the change.
  Two clean instances in v14.30.0; see [`docs/DESIGN_NOTES.md`](./DESIGN_NOTES.md).
- Atlarix GitHub account for contributor credit (owner action, code done); user-message multimodal
  parts for HISTORICAL turns (current/edited turns embed since v14.8.11; history round-trips via
  `read_attachment`). **Dropped 2026-08-19:** the `.gitignore`-render profiler (v14.8.10 §3.4) — six
  releases old with no observed problem; and the `proxy-worker`-from-source self-test gap, which is
  a known limitation with a stated substitute (`proxy-passthrough.test.ts`), not a task.
- **Dependency deprecation triage — SUPERSEDED**, half done and half rescheduled. The in-range sweep
  and the security work landed in v14.35.0 (54 → 28 advisories); the spec-line majors are now the
  **`migration` branch** described under "Blocked on the owner". Constraints that still hold: the AI
  SDK stack must stay on MATCHING majors — currently **`ai@6` + v3-spec providers**
  (`@ai-sdk/anthropic@3.x`, openai 3.x, openai-compatible 2.x) since v13.3 — and zod moves WITH them.
  Corrected from the old text: there are **2** patch-package patches, not 4 (see the release record),
  and the only ABI-pinned native module is **better-sqlite3** — `node-pty` is N-API and `keytar` is
  not a dependency at all.

---

## 🔭 Long-term / far-off (not soon)

- **Collaborative agent (the "team + @atlarix" direction).** NOT a Slack/Discord clone — real-time
  chat + calls is a money pit and teams already have those. Two pieces instead: (a) **`@atlarix`
  bots inside the tools teams already use** — Slack / Discord / GitHub issues — extending the
  existing `@atlarix review` bot: mention it, it picks up the task, works in a real Atlarix
  workspace, posts the result back (near-zero switching cost; how Devin / Copilot-in-Slack win).
  (b) A **shared, observable agent session** — a war room where teammates watch one run live, drop
  steering comments, approve actions and hand off, tied to the Workforce tier. The chat shell is not
  the differentiator; the shared *agent* session is. Capture, don't build yet.

---

## 📦 Shipped — index

Full prose in [`docs/CHANGELOG.md`](./CHANGELOG.md); older versions live there only. Listed here for
the trap each release left behind, because those cost time twice.

| Version | Shipped | Trap worth remembering |
| --- | --- | --- |
| **v14.32.0** | native PDF parts; process-tree kill; type-coerced tool args; `read_url` cache; browser panels per page load; system-wake admission control | **A decision that is GLOBAL cannot be made from per-window state, however carefully it is guarded.** Three renderer guards (a jotai store + two hook refs) all looked correct and were all blind across windows, while the listener they protected keyed on the chat id in the EVENT — so a second window woke a chat another window was mid-turn on, 84 times in six minutes. Also: the runaway ACCELERATED (0.75s → 6.5s cycles) because each discarded turn lengthened the history — a feedback loop is easier to spot by its changing period than its rate. And a refused dispatch must not settle through `onEnd`, because `onEnd` is the auto-wake itself. A **provider-level** capability allowlist is wrong wherever a provider's catalog is mixed — OpenAI accepts PDF on 15 of 47 models, Google on 21 of 41 — so gate per MODEL and let unknown fall back to the old path. `proc.killed` only records that YOU signalled; check `exitCode`/`signalCode` for whether it actually died. A test that pins the OLD behaviour (the console card labelled with the *latest* url) will fail the fix and must be rewritten, not deleted — and **verify a new test would have caught the bug**, since these all sat green either way until checked. |
| **v14.31.0** | Network tab; browser runtime gating removed; session-restore hang; notification crash | `Network.enable` **hangs forever** on a tab that has never navigated — attach resolves, the command never does, no error at all; prime `about:blank` first and time-bound every CDP command. A `Notification` you stop referencing after `show()` is collected while the OS is still displaying it, and the teardown races the daemon's — a native `SIGSEGV` no JS handler can see. A broadcast that early-returns on the empty case (`if (!s) return`) can never clear a loading flag, so **the failure case is exactly the case that gets no message**. |
| **v14.30.0** | on-device dictation on Windows/Linux; ORT served from inside the app | An error names the model that **reported** it, not one that was ever loaded — two diagnoses were wrong before the (device × dtype) matrix settled it. And `postinstall`'s trailing `\|\| true` guards **patch-package**, absent from the pruned tree, not the Electron install; re-parenthesising it broke Windows packaging at tag time. |
| **v14.29.0** | automated Store submission, WSL Landlock confinement, sandbox path fixes | `latest-mac.yml` is arm64-only by design. Duplicate asset uploads **422 green while keeping the OLD asset** — delete the draft before re-tagging. |
| **v14.28.0** | MSIX on every tag; Windows sandbox rebuilt on Low IL | AppContainer is deny-by-default on **reads** — the inverted primitive, unfixable per-path. `cargo check --target x86_64-pc-windows-msvc` works from macOS; `cargo build` on `cfg`-gated crates proves nothing. |
| **v14.27.0** | credentials stop vanishing; agent-visible automations | The preload strips the Electron event — renderer listeners must be `(payload) =>`; 11 written `(_e, payload)` silently never fired. `useAuth.loading` cannot distinguish "signed out" from "not known yet". |
| **v14.26.0** | one engine for every file lookup; one answer per permission question | A Windows **drive-letter colon** is not a field separator (grep discarded every match); an absolute glob must resolve on Windows too. `path.isAbsolute("C:\\x")` is false on macOS, so no dev machine catches either. |
| **v14.25.0** | honest context accounting, skills on demand, one grant list | A delta cache froze the newest row; `compatibleModes: [Debug]` silently meant EVERY mode; `ContextAssembler`'s budget is `Infinity`, so its trimReport is always empty. |
