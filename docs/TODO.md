# Atlarix TODO

**Current version:** v14.42.0 — released 2026-09-03. A message you type mid-turn now reaches the
turn that is RUNNING instead of being parked until it ends, delivered as an untagged user turn on
the next step and inserted into the transcript in front of the streaming row. The queue moved to
main and became a list (a second message used to be silently rejected). Plus the three-defect
chain behind it — the queued flush pre-empting a question card, a stop latch an answer could not
clear (five sub-agent wakes refused), a sub-agent card frozen mid-count — and the user bubble's
glare.

**Self-test non-exit — a third data point (2026-09-05).** The packaged self-test on
macOS arm64 shows the same "all probes passed, process tree had to be killed" as the
Windows runs. Two consecutive runs of the SAME build differed only in outcome: one
FAILED → exited 1 on its own; one PASSED → did not exit. **It happens on the PASSING
path**, and nothing was left running afterwards. Next step is the grandchild
experiment recorded in `scripts/run-packaged-self-test.mjs`'s `DEADLINE_MS` docblock,
now runnable on macOS where a debugger is available.

## Queued 2026-09-06 (owner) — UX + product

**Five of six SHIPPED 2026-09-07.** Kept as a one-line record each, because the next
reader's question is "was this done?" and an item that has to be re-investigated to
answer that costs more than the line.

- [x] **Deep-search truncation** — `657ba43c`. Both halves measured first, as this item
  demanded: synthesis drops NOTHING (it concatenates fetched content verbatim), and 20K
  was genuinely too small (every page sampled ran 25K–75K chars). Fixed by ALLOCATING a
  total across the URLs actually fetched (`deepFetchBudget`) rather than raising the flat
  cap, so five results are unchanged and one or two get the whole budget.
- [x] **Unsent draft survives a quit** — `856ff33e`. Keyed by SESSION UUID, which
  sidesteps the ephemeral-numeric/persisted-UUID migration this item warned about rather
  than implementing it. Residual, deliberate: a draft typed in the few milliseconds
  before a session has a UUID is not persisted.
- [x] **Settings/Integrations sub-nav dropped** — `e7884f4b`. The item's premise was
  wrong: the sidebar carried NO destination the tab row lacked (8 == 8, 5 == 5). The
  real work was that removing the mounts left an empty 240px hover flyout.
- [x] **New-window button + clock moved to the rail** — `0b5d7257`. Two corrections: they
  were never in the chat header (they were in the AppList group header), and the clock is
  NOT a history button — `LocalDateTimeClock` has no onClick. **If a session-history
  button is wanted, that is a new feature, not a move.**
- [x] **Session ordering on reopen** — `6c5dcf3e`. Two faults: reopen resumed the newest
  session, AND the row handler no-opped on the already-active row, so the top row was
  inert from anywhere in the app.

- [ ] **Language option — IN PROGRESS.** Thirteen locales:
  `en-us, zh-hans, fr, de, hi, it, ja, ko, pl, pt-br, ru, es, tr` — and the Microsoft
  Store listing already carries all thirteen, so no Store work is owed. **Owner chose
  both halves in one release (2026-09-07)**, against the recommendation to ship the
  response language first; the mitigation held is that each lands as its own commit so
  the two prompt-budget ceiling movements stay separately attributable.
  - [x] **PR-A infrastructure** — `26da434e`. i18next 26.4.2 + react-i18next 17.0.13,
    `src/lib/i18n/locales.ts` as the single source of truth, `appLanguage` as an ENUM
    (unlike free-form `voiceLanguage` — a value here selects a bundled catalog, so an
    unknown tag is a blank UI), the `settings:changed` broadcast that fixes cross-window
    staleness, and two guards proven to fire: TypeScript key types, and `check:i18n`
    with a hardcoded-string ratchet at 315.
  - [ ] **Response language.** In `stableHeader`, NOT the per-turn tail as this item
    originally said — locale is stable for a session and the tail is the cache-hostile
    half. Emit only when the locale is not `en-us`, so English installs pay zero. Needs a
    SIXTH case in `prompt-budget.eval.test.ts` with `appLanguage: "fr"`, or the cost is
    never measured (the suite runs in English) and the feature could ship silently dead.
    **`AGENTS.md` must not carry it** — that file IS the shipped prompt, sent
    unconditionally to every user.
  - [ ] **UI i18n** — ~177 files, ~1,300 strings, estimated 7 weeks. Lands as PRs B–H,
    one surface per catalog namespace so siblings never conflict: tool-activity-labels
    (139 strings, best ratio, proves the pipeline) → settings → chat → components →
    onboarding → main process → the 12 non-English catalogs.
  - Decided and worth not rediscovering: **RTL is fully descoped** (all 13 locales are
    LTR, and `check:i18n` fails if that changes); **diagnostics stay English**
    (`doctor.ts`, `self-test.ts`, `database-init-failure.ts` — a translated stack trace
    makes support harder); **`whats-new.ts` is fetched from `atlarix-releases` and no
    bundled catalog can reach it** — decide whether it stays English or the remote JSON
    gains a per-locale shape.
  - Three hazards that are NOT RTL: German/Russian/Polish run 30–40% longer (that is the
    layout budget); Geist has no CJK or Devanagari glyphs, so zh/ja/ko/hi need the font
    stack extended; and Turkish casing needs `document.documentElement.lang` (done in
    PR-A).

## Traps from v14.41.0 (2026-09-02)

- **An alias resolves a NAME, not a dispatch.** `ToolMetadata.aliases` made `browser_navigate`
  resolve to `browser` in the registry, and `tool-name-aliases.test.ts` passed — but both dispatch
  paths look the tool up in the resolved ToolSet first, which advertises canonical names only. The
  text-tool path answered `Error: Unknown tool "browser_navigate"` and the native path never
  reached Atlarix code at all. **If you rename a tool, test a DISPATCHED call by the old name, not
  `ToolRegistry.get`.**
- **Making an alias executable is a permission change.** A deny rule is a plain string match. Once
  `browser_navigate` runs, a rule on `browser` must catch it AND a rule already written against
  `browser_navigate` must keep catching it. The gate evaluates both names; canonicalising at the
  dispatch site instead looks correct and silently voids every pre-existing rule.
- **`oxlint`'s `no-unreachable` is a design signal.** Re-keying the browser labels left a trailing
  `return null` unreachable; every label test still passed because they only pass browser tools.
  The warning forced the real question (what happens to a non-browser tool?) — the answer was the
  guard at the top of the function, which had to be checked rather than assumed.
- **A bulk substitution inside string literals produces unescaped nested quotes.** Replacing
  `browser_navigate` with `browser({action:"navigate"})` broke five double-quoted strings in
  `browser.ts` and `shell.ts` — twice, in two separate passes, because the second pass reintroduced
  it. `tsc` catches it; a grep-and-replace does not. Prefer quote-free prose in model-facing strings.
- **Retiring a feature leaves typed orphans a type-checker will not find.** §3 deleted the GitHub
  poller but left `GithubTriggerEventSchema` (a runtime value, so knip could not see it as an unused
  type) and `GithubCursor`. Run `npx knip` AND grep the feature's noun after any deletion.
- **`keytar` / `mysql2` / `pg` — the premise was WRONG, and the residue is one line.**
  This was filed as "three staged deps that look unnecessary… real install cost and a
  build-failure surface", with a warning that removing them might crash the packaged app.
  Re-checked 2026-09-07: **none of the three is a dependency at all** — not in
  `package.json`, not in `package-lock.json`, not in `node_modules`. They cannot be
  installed into the app, because `packageAfterPrune` installs `keepRoots ∩ fullDeps` and
  they are in neither. So there is no bloat and no crash risk.
  The only real residue is three unnecessary entries in `mainRollupExternals`
  (`vite.main.config.mts`), which is a tidy-up, not an investigation. Worth recording
  because the original framing would have sent someone to verify a crash that cannot
  happen — and because the lesson is the general one: an item that reasons from a build
  LOG ("the log names the roots it cannot pin") is reasoning about a different set than
  the one that ships.
- **RELEASE INTEGRITY: the staged-app dependency pinning had silently never worked.**
  `forge.config.ts`'s `packageAfterPrune` reads `package-lock.json` to install the staged app's
  runtime deps at the EXACT versions that were tested. Inside that hook,
  `const fs = await import("node:fs/promises")` shadows the top-level
  `import fs from "node:fs"`, and the promises API has no `readFileSync` — so the try always
  threw, the catch always fired, and every release installed all 31 roots UNPINNED. **The tell is
  in the build log: `could not read package-lock.json (fs.readFileSync is not a function)`
  followed by `0 pinned from package-lock`.** Fixed to `await fs.readFile`. It means every
  shipped build so far may contain dependency versions that were never tested — worth knowing
  when triaging a "works on my machine" report against an older release.
  **Verify by log, not by reading the code:** the line must say `N pinned from package-lock`
  with N > 0.
- **`npm run package` is NOT concurrency-safe.** It starts with `npm run clean`, so a second
  package run started while the first is finalizing deletes the first's electron-packager staging
  directory. The first then dies as `ENOENT ... lstat /var/.../electron-packager/tmp-XXXX`, which
  reads exactly like a build bug and is not one. Run one at a time. (The
  `Cannot find module .../node_modules/electron/install.js` line in the log is unrelated and
  benign: the staged app's `postinstall` references a devDependency that is correctly absent, and
  the script's own `|| true` swallows it.)
- **A tool result's field NAMES are a UI contract, not just data.** The browser expand card reads
  `title` / `url` for its header and `content` / `note` for its body. `mobile_inspect` first
  returned `summary` and `mobile` returned `detail` — both landed in `BROWSER_TEXT_TOOLS`, both
  rendered as a bare "Done", and the model still saw everything, so nothing looked broken. Match
  the existing field names instead of widening the renderer.
- **`success: false` is not the same as "failed", and a generic fallback ASSERTS something
  untrue.** Two of the commonest results in a long session rendered as a red "Tool failed"
  under a green ✓: `compress_context`'s no-op (`status:"noop"`, with a `summary` reading
  "Already compact: history is 7474 tokens (~39%…) — nothing worth compacting") and the loop
  guard's declined call (`loop_guidance`: "…This call was NOT executed"). `envelopeFromObject`
  read only `error` and `message`, so both explanations were discarded. **The chain now walks
  error → message → loop_guidance → summary → reason → detail → note**, and `status:"noop"` /
  `loop_guidance` mark a result as NOT an error. Header fixed too — "Context compacted" was the
  one thing that had not happened.
- **The registry's failure sentinels must not reach the user.** `ToolRegistry.execute` fills in
  `error: "TOOL_ERROR"` and `message: "Tool returned an error"` when a tool supplies neither.
  The first version of the fix above read `error` first and so displayed "TOOL_ERROR" — worse
  than "Tool failed", because it looks like an error code you could look up. They are skipped
  in favour of a real field, and kept only as a last resort so an unexplained failure is not a
  blank card.
- **Read the DB, not the log, for what a tool actually returned.** `main.log` records no
  structured tool results, so the payload behind a bad card is invisible there. It IS in
  `session_messages.content` in `~/Library/Application Support/Atlarix/sqlite.db` — the
  `<atlarix-tool-result …>` blocks hold the verbatim JSON. Two rounds of reasoning about the
  wrong envelope shape ended the moment I queried it: the text-tool path stores the handler's
  raw return, while the native path stores the registry's wrapper, and they render differently.
- **A tool's own error message decides whether the model recovers or thrashes.** Filling
  Wikipedia's Vector search failed with **"Illegal invocation"** — a native `value` setter
  invoked on a wrapper element, because the code picked the prototype by ELIMINATION
  (`textarea ? … : HTMLInputElement.prototype`). A native accessor rejects a receiver of the
  wrong type, so a wrong guess throws instead of degrading. Observed cost: the model retried
  the same call twice, tried a click-then-fill batch, concluded the whole action system was
  broken, and worked around it — **three wasted turns for a wrapper element.** Two fixes: walk
  to the field the wrapper contains, and choose the prototype from what the node IS.
- **The model's post-mortem is not evidence.** That transcript reads "Both click and fill are
  failing with Illegal invocation" and "the entire action pathway is broken for refs on this
  page". Neither was true: only `fill` ever failed, and the batch it blamed had failed at its
  fill STEP. There is exactly one `.call` site in the whole browser tool. **Grep for the
  mechanism before believing the narration.**
- **"Done" means a tool has no expand branch.** `tool_help` returns `{ tool, usage }` and the
  card reads `content`/`note`, so every reveal rendered as a bare "Done" — the tool whose
  entire purpose is to be READ was the one the UI hid. Third instance of this class this
  release (see also the mobile pair). **A new tool needs a `tool-expand-view` branch or a
  result shaped like an existing one.**
- **A computed label subject is silently DISCARDED without an `ARG_VERBS` entry.** Adding
  `tool_help` to `subjectFromArgs` changed nothing until the verb map had a row too, because
  the verb lookup came back `undefined` and there was no fallback. The done-tense path is a
  separate branch again — so a label can end up correct in one tense and generic in the other.
- **ONE implementation, SIX announcements — the consolidation that got left behind.** v14.39.0
  unified compaction into one compactor with three triggers and left the *announcing* hand-rolled
  at six call sites across four files, with three labels ("Context compacted automatically",
  "Context compressed", "Summarizing in-task context") and inconsistent event types. **That
  inconsistency was itself the bug:** `context-assembly.ts`'s automatic pre-dispatch compaction
  emitted only `type: "compaction"` (dropped by the renderer, by design) and never the
  `background` event the pill reads — so the trigger nobody asks for was the only one with no UI,
  reported with the ring at 100%. `emitModelCompactionActivity` had the same defect from a
  different cause: its `background` event sat inside `if (outcome.success)`, so a no-op was
  invisible too. Now `emitCompactionActivity` is the only emitter, and **the label is derived
  from trigger + phase rather than passed in** — a per-site label string is exactly how three
  variants drifted apart. When you unify an implementation, check whether its NOTIFICATIONS were
  unified with it.
- **Do not "fix" a deliberate drop.** Compaction was invisible mid-turn, and the obvious cause
  looked like `chat-activity-normalize.ts` omitting `"compaction"` from `VALID_TYPES`. That
  omission is INTENTIONAL — the main process emits a `compaction` banner event AND a parallel
  `background` one, and admitting both would put two rows in the atom for one moment.
  `compress-context-persistence.test.ts` pins it as the Bug 1c contract and caught the wrong
  fix immediately. The pill reads the `background` row by label instead, the same shape
  `useCompactionTokenVisuals` already used. **A missing entry in an allowlist may be the
  decision, not the bug** — and `compaction-activity.ts`'s comment pointing at a
  `CompactionProgressStrip` that no longer exists is what made the wrong reading plausible.
- **A test fixture can keep a dead query branch alive.** `listConfiguredMcps` read
  `scope = 'global' OR (scope = 'workspace' AND appId = ?)`, and two MCP evals inserted their
  server with `scope: "global"` — a shape production cannot produce, since migration 0049 deleted
  every global row and both writers in `mcp_handlers.ts` hardcode `"workspace"`. Removing the dead
  branch broke both evals, which looked like a regression and was the opposite. **When a change to
  a query breaks a test, check what shape the FIXTURE creates before assuming the change is wrong**
  — and verify a "no code path does X" claim by naming the writers, not by reasoning.
- **The `simctl` `-` bug left a 2.8 MB file named `-` in the REPO ROOT.** Found during release
  prep, one `git add -A` away from being committed. The live-iOS test ran with the repo as its
  CWD, and `simctl io <id> screenshot -` writes a file literally called `-` there. The code is
  fixed (temp file, then unlink), but check for it before any commit that follows a mobile test
  run: `ls -- './-'`. A filename of `-` is also awkward to delete — `rm -f -- './-'`, since
  plain `rm -- -` and `rm '-'` both fight the shell.
- **iOS half VERIFIED on a live simulator 2026-09-02; ANDROID verified 2026-09-04** against a
  real API 35 emulator — see the trap below, where the first command it issued turned out broken.
  `mobile-live-ios.test.ts` runs against a booted simulator and `describe.skipIf`s itself when
  there isn't one, so it stays in the suite. **It is the only thing that found any of these,
  and the mocked suite was green throughout:**
  - `simctl io <id> screenshot -` does NOT stream to stdout the way `adb exec-out screencap -p`
    does. `simctl` treats `-` as a FILENAME: exit 0, "Wrote screenshot to: …/-", zero bytes on
    stdout, and a junk file called `-` left in the working directory. Temp file now.
  - `--predicate 'messageType >= "Default"'` matches **NOTHING** — 0 characters where the
    unfiltered query returned 18.7 MB. Not an error, a silent zero: every iOS log read said
    "No recent entries" regardless. Apple's log has no "warn"; the types are Default, Info,
    Debug, Error, Fault, and the comparison operator does not work on that field. Equality now.
  - Volume: a simulator's log is the WHOLE OS. 2 minutes filtered to errors is 3.2 MB, 30
    seconds is 1.7 MB, and a `process` filter is **184 characters**. Hence the bounded window
    and the `package` parameter.
  - A live screenshot is 2.85 MB (~3.8 MB base64), so there is now a downscale AND a hard
    refusal above 1.5 MB — the downscale needs Electron's `nativeImage`, and its fallback
    would otherwise send the raw capture.
- [x] **ANDROID VERIFIED 2026-09-04, against a real API 35 emulator — and it was BROKEN.**
  Covered by the new `src/__tests__/mobile-live-android.test.ts` (
  `describe.skipIf(!hasBootedDevice())` so it costs nothing without an SDK). Emulator installed
  for the run and deleted immediately after.

  **THE BUG: `adb shell uiautomator dump /dev/tty` RETURNS NO XML.** Exit code 0, and stdout is
  exactly `UI hierchary dumped to: /dev/tty` — 32 characters, upstream's typo included, and not
  one byte of a document. `adb shell` allocates a pty and the XML written to /dev/tty never
  reaches adb's stdout stream. **The whole Android read path returned nothing, silently, since
  v14.41.0.** Fix is one word: `shell` → **`exec-out`**, which takes the raw binary path and
  returns 12,338 characters. One call site (`readHierarchy`), used by both the read and the
  per-act ref resolution, so one fix covers both.

  It is the **same silent zero** as `simctl io <id> screenshot -` writing a file named `-`: exit
  0, a plausible message, nothing usable — and it survived a green mocked suite for the same
  reason. That is now twice in one tool, on two platforms, from the same cause. **The rule has
  earned promotion from "write a live test" to a design rule: a wrapper around an external CLI is
  UNVERIFIED until it has run against that CLI, and the assertion that catches this class is
  about the SHAPE of real output (a document containing nodes, PNG magic bytes, a non-zero
  count), never about the arguments passed.**

  What the run confirmed WORKS, once the dump is fixed: 14 elements parsed with correct centres
  (centre, not corner); `mobile_inspect` returning 840 characters of text; `exec-out screencap
  -p` genuinely streaming (1,374,951 bytes, PNG magic `89504e47`); **tapping a real element by
  ref** (`m3` → "Tapped drag_layer"); a stale ref failing loudly with the re-read instruction
  rather than acting on whatever now occupies the index; `settings get system show_touches`
  returning the literal string `null` when unset, which is exactly what the restore path is
  written to expect.

  **THE SECOND BUG, found only because the checklist was finished: `action:"launch"` NEVER
  WORKED on Android.** The recipe was `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`,
  which is the widely-copied one and is wrong: on API 35 monkey exits **251**, writes its
  argument dump to **stderr**, and `topResumedActivity` never changes. `execFile` surfaced the
  non-zero exit with monkey's own arg-echo, so the tool reported a baffling
  `adb -s: args: [-p, com.android.settings, …]`. Fixed to resolve the component first —
  `cmd package resolve-activity --brief <pkg>` (the launchable component is its LAST line;
  earlier lines are match metadata) — then `am start -n <component>`, which exits 0 and really
  does foreground the activity.

  **The rest of the checklist, now actually run:** `type` into a real field ✓ · `swipe` ✓ ·
  `key` back ✓ · `launch` ✓ (after the fix) · logs unfiltered (6,799 chars) and narrowed by
  `package` (6,261) ✓ — note `-t N` bounds volume first, so the dramatic iOS-style reduction is
  not visible and that is not a defect · the tap-feedback ROUND TRIP ✓: note emitted,
  `show_touches` → `1`, and after `restoreTapFeedback()` the key is ABSENT again (reads `null`)
  rather than holding the four-character string `"null"`.

  **The OS sandbox DOES permit `adb`'s local socket — on macOS.** Through `sandbox-exec` in
  read-only mode, `adb devices && adb shell getprop sys.boot_completed` returns
  `emulator-5554 device` / `1`. Windows (Low IL) and Linux (Landlock) are still unverified for
  this and need those machines.

  **STILL not exercised:** iOS `launch` (needs a booted simulator — the Android branch changed,
  the iOS `simctl launch` branch did not), and Windows/Linux sandbox reach for `adb`.

- **A LESSON ABOUT `ToolRegistry.execute`'s ENVELOPE, because it made me accuse working code
  twice.** A successful handler result is nested under `result` — but when the payload is large,
  `guardToolCall` truncates it and `result` arrives as a **JSON string** alongside
  `_truncatedOutput` / `_originalSize`. Reading `.content` off that string yields `undefined`,
  which is indistinguishable from a tool that returned nothing: that is exactly how
  `mode:"logs"` looked broken while it was returning 400 lines of real logcat. Any test driving
  a tool through `execute` needs an unwrap that handles BOTH shapes.
  The sibling trap in the same file: `runDeviceCli` returns both `stdout` (a UTF-8 string) and
  `buffer`, and reading a PNG from `stdout` corrupts byte 0 (0x89 is not valid UTF-8), so the
  magic-byte check fails on a perfectly good image. Two of my four "findings" were my own
  harness. **A live test can produce false accusations as easily as a mock produces false
  confidence — confirm the failure against the raw CLI before believing the wrapper is at
  fault.**
- **A test that reuses the implementation's own predicate cannot catch the predicate being
  wrong.** `resolve-toolset-unattended.test.ts` asserted `!names.some(n => n.startsWith("browser_"))`
  — the same expression as the filter it was testing. When `browser` lost its underscore the
  filter stopped covering it and the test kept passing, VACUOUSLY. It now NAMES the five
  view-driving tools, and has a positive control (attended runs DO get them) so
  "dropped everywhere" cannot pass either. Verified by reverting the filter and watching three
  tests fail.
- **`vi.mock` cannot intercept a call made inside the same module.** `ensureTapFeedback` calls
  `runDeviceCli` from within `device-tools.ts`, so the call is a lexical binding that never goes
  through the module's exports — a spread-mock of the module leaves it untouched, and the test
  observes nothing while looking like it works (empty `calls` array, four confusing failures).
  Use an explicit seam (`setDeviceCliRunnerForTests`, same shape as
  `setGlobalAtlarixDirForTests`) rather than restructuring production code around the mock.
- **Two things the security review flagged as CONTEXT, not findings — both pre-existing, both
  worth knowing.** (a) `pollMcp` (`automations/pollers/mcp.ts`) looks a server up by
  `trigger.serverId` with **no workspace predicate**, and `upsertMcpConsentIfNeeded`
  (`automations/service.ts`) grants `consent:"always"` for an arbitrary `serverId`. It is not
  exploitable across workspaces today because the invocation still goes through `mcp_call` with
  the automation's own `workspaceId` — the id is used only for the name lookup and the consent
  row. Untouched by v14.41.0; tighten it when automations are next opened. (b) `forge.config.ts`
  interpolates a lockfile `version` into `name@<value>` and `runNpmInstall` uses `shell: true`
  on Windows, so a crafted `package-lock.json` could yield an unexpected package spec. Requires
  write access to the lockfile, which already dictates tarball URLs and can carry `postinstall`
  — so it grants nothing new. Belt-and-braces if ever wanted: reject a version not matching
  `/^\d+\.\d+\.\d+[\w.+-]*$/` and resolve `npm.cmd` explicitly instead of `shell: true`.
- **`RulesetDecision` is deny-only, and the permission gate's `??` composition DEPENDS on that.**
  `evaluateRuleset` returns `{kind:"deny"} | null` — there is no allow decision — which is why
  checking the as-called name and then the canonical name cannot fail open. **If an allow or ask
  decision is ever added to the ruleset, revisit `tool-execute.ts`'s composition before doing
  it**, because a non-null allow would short-circuit the canonical check.
- **SECURITY REVIEW FINDING (fixed): the same value, three treatments.** `mode:"logs"`'s
  `package` was interpolated into an iOS NSPredicate with no validation, while
  `action:"launch"` validated the identical kind of value and the Android logs path quoted it.
  `.split(".").pop()` is not a sanitiser — a dotless payload survives it whole — so
  `x" OR message CONTAINS "password` widened a filter the tool still reported as app-scoped.
  Validated once up front now. **When one untrusted value reaches several call sites, the risk
  is the DIFFERENCE between their treatments**, because checking one site convinces you the
  value is handled.
- **`execFile` protects the local shell, not the far one.** `adb shell <args…>` joins its
  arguments and runs them through `/system/bin/sh -c` on the DEVICE, so an argv array buys
  nothing there: `input text "a; rm -rf /sdcard/x"` runs the `rm`. Quote for the device shell.
  The reason it matters is not agent privilege (it has `run_command`) but that an agent types
  what it READ — this is a prompt-injection path into a device shell.
- **A prefix test is only as stable as the naming convention it assumes.** `resolve-toolset.ts`
  dropped UI-driving tools headless/unattended with `startsWith("browser_")`. Consolidating to a
  tool named plain `browser` made that FALSE, so the act tool was silently offered to headless
  benchmark runs with no window and to unattended automations nobody watches. The plan itself
  asserted this filter "keeps working automatically" — it did not. Now a named `DRIVES_A_VIEW`
  predicate lists the tools, and `mobile_*` is in it for the same reason.
- **`NEVER_TRIM` has a bar, and the alternative is usually better.** `mobile_inspect`'s
  screenshot-is-a-last-resort wording mirrors `browser_inspect`'s, but that list is for prose
  preventing an OBSERVED failure and no device has been driven yet. Instead the tool's DEFAULT
  (no `mode`) is the cheap text read, and its first sentence — the only part a peripheral tool
  binds — says so. Work with the reveal mechanism rather than exempting yourself from it.
- **A ceiling left high is a ratchet that only loosens.** `prompt-budget.eval.test.ts`'s per-mode
  ceilings move DOWN with every prefix reduction, or the next accidental growth is free.
- **A deleted UI control can make a threat model worse, not better.** `DESIGN_NOTES.md`'s
  nested-repo-trust note cited the clone dialog as the re-entry path. Deleting the dialog made a
  mid-session clone the ONLY way to clone, i.e. the normal case. Re-read a threat note when you
  delete the thing it names.

## ✅ `browser-recorder.ts` is LIVE — do not delete it

Proposed for deletion 2026-09-04 as "never in use". It is in use, end to end, and the chain is short
enough to re-check in one grep — so this note exists to stop the next proposal:

`browser.ts` calls `recordBrowserAction` at ~15 sites, and at `browser.ts:595-619` attaches
`sessionWalkthrough` (markdown, back-compat) and `sessionSteps` (structured) to the **screenshot**
result → `tool-expand-view.ts:1226` reads `payload.sessionSteps` and at `:1237` produces
`kind: "browser_recording"` → `ToolExpandPanel.tsx:43` renders `ToolBrowserRecordingExpand`. Covered
by `tool-expand-view.test.ts:174-188` and `browser-recorder.test.ts`.

**Why it FEELS unused, which is the real point:** its only trigger is
`browser_inspect(mode:"screenshot")`, which the tool description deliberately calls a LAST RESORT.
A feature reachable only from a discouraged path is rarely seen and still wired. *Rarely exercised is
not the same as unreachable* — this is the same reachability-not-presence rule the Dyad-era removal
ran on.

## 🧩 Browser extension — drive the user's OWN browser (queued 2026-09-07)

**The gap it closes.** We ship an in-app Chromium, but the user's session lives in THEIR
browser. Anything behind a login — Metabase, Airtable, an internal dashboard, any
SSO-walled URL — is unreachable to us and trivially reachable to them. This is the
single biggest coverage win available: ~85% of desktop-agent tasks need no GUI control,
but a large share of the remainder is "the thing I'm already logged into".

**Two dead ends, measured 2026-09-07, so nobody re-derives them:**
- **CDP attach to the running browser is CLOSED.** Chromium ≥136 refuses
  `--remote-debugging-port` when the browser is on its default user-data-dir — shipped
  deliberately to kill a cookie-theft vector. You can only get a debug port on a fresh
  profile, which by definition has none of the user's logins. Verified against Brave 150
  on the owner's machine: no debug port open, and none obtainable.
- **Cookie import is CLOSED.** Chrome's App-Bound Encryption (Chrome 127) binds cookie
  decryption to Chrome's own app identity, so another process running as the same user
  cannot read the cookie store. Add SSO and device trust on top.

**So the shape is an extension + native messaging**, which is the only sanctioned route
into an authenticated session:

```
Atlarix (desktop)  ←native messaging (stdio)→  MV3 extension  →  the user's real tab
```

- One build covers Chrome/Edge/Brave; Safari needs a separate Safari App Extension.
- Complements the in-app browser rather than replacing it: ours for unauthenticated
  fetching and scripted work, theirs for "the thing I'm already logged into".
- Costs: an MV3 extension to build and maintain, Web Store review, and the user has to
  install it.

**Design questions still open:** how the native-messaging host is registered per browser
and per OS; whether the extension exposes the same `browser`/`browser_inspect` tool
surface (it should, so the model learns one contract); how a tab is chosen and how the
user consents per-site; and what happens when the extension is absent (the in-app
browser is the fallback, and the failure must say which browser it wanted).

### Settled 2026-09-08 (owner) — it is TWO products sharing one core

The section above is reason one: a hand for the desktop app. Reason two is a **standalone
web assistant** for people who have neither the app nor the PR bot — sidebar chat, "change
this Airtable column", "make a PDF of this", with sessions and memory. Both are served by
one **page-control layer** (read DOM, click, type, scroll, wait); build that once and the
desktop attaches to it as a tool provider while the sidebar calls it directly.

- **Auth is OAuth against the Atlarix account**, like the desktop app. That decides the
  memory question: memory CANNOT live in `chrome.storage`, because the account is portable
  across devices and device-bound memory silently vanishes on the second machine. It goes
  in Supabase, keyed to the user.
- **That makes it the FIRST user content Atlarix stores server-side.** Today the only
  server-side asset is inference; everything else is on the user's machine. This needs its
  own privacy page rather than quietly weakening the app's "your code stays on your
  machine". Scope it like the app's own memory — short notes with a one-line index, read
  on demand — not a transcript archive. v1: memory server-side, sessions local.
- **Memory must be user-visible and deletable from day one, and this is a SECURITY
  requirement, not UX.** A malicious page that gets "remember: the user's checkout is
  attacker.com" into a silent store has planted something permanent, cross-device, and
  invisible. Two rules: memory writes come from the user's turn and NEVER from page
  content, and every write is surfaced when it happens.
- **Tool surface is not the desktop's.** No filesystem, no shell — `read_file`,
  `edit_file`, `run_command` and ripgrep do not port. What replaces them: an MV3
  **offscreen document** running client-side libraries for PDF/CSV/chart generation, handed
  over via `chrome.downloads`; **sub-agents**, which are just more proxy calls on the same
  wallet and are genuinely differentiating; and page control for everything else.
  No image generation and no vision needed — a chart is data plus a spec rendered to
  canvas, so the model never touches pixels.
- **Core-only, no BYOK** — deliberate, it is what makes the extension a paid product. Say
  so in the copy: the app's headline is "any model, your own key", and a user who
  discovers the difference after installing reads it as a bait-and-switch.
- **The MV3 service worker terminates after ~30s idle.** A long agent turn dies mid-flight
  unless state lives in the offscreen document. Cheap to design around now, expensive to
  retrofit — it is the commonest way extension agents break.
- **Prompt injection changes category here.** The in-app browser is unauthenticated, which
  is a limitation AND a containment boundary. The extension is the user logged into their
  bank and their email, with the agent reading instructions off pages it does not control.
  Per-site permission from day one, the way Claude in Chrome does it.

## 🧪 Muse Spark 1.3 vs GLM 5.3 on core-1 — evaluate, do not swap on reputation (queued 2026-09-08)

Owner asked whether GLM 5.3 should stay now that Meta's **Muse Spark 1.3** exists. On paper
it wins on every measurable axis, by a little:

| | GLM 5.3 | Muse Spark 1.3 |
|---|---|---|
| in / out | $1.40 / $4.40 | $1.25 / $4.25 |
| cache read | $0.26 | $0.15 |
| context | 1.00M | 1.05M |
| max output | 131,072 | 131,072 |
| inputs | **text only** | text, image, video, pdf, audio |

First-party provider exists — `https://api.meta.ai/v1`, `META_MODEL_API_KEY`,
OpenAI-compatible — and OpenRouter carries `meta/muse-spark-1.3` as a rollback target.
Adoption would be one line in `PROVIDER_KEY_ENV_NAMES`, a `providers.meta` block, and an
entry in `pick-core-model.mjs`.

**Why it is queued rather than done.** The price win is ~11% input / ~3% output, which does
not by itself justify a provider migration; the real prize is multimodal on the BUDGET tier.
And core-1 is the tier **Atlarix Reviewer runs on** — 39c a review, 4 findings, zero false
positives on the live run. Swapping the proven reviewer model on reputation is the one move
here with real downside. Run `npm run eval` before deciding, and check Meta's billing
accepts a Kenyan card BEFORE any integration work — that is exactly what wasted the Kimi
round.

**DO NOT use the `-contributor` variants.** `muse-spark-1.3-contributor` is $0.10/$0.20 —
12x cheaper and very tempting — and its catalog name is "Data Used for Training". Routing
customer code through it contradicts "The Private AI Workstation" and the README's promise
that Core requests are not logged or retained.

## 🔜 Next session — the queue

*(Unordered. It read "in order" while numbered 1, OPEN, 0, 1b, 3 with no 2 —
numbers that do not sequence are worse than none.)*

### Harbor upstream integration — IN PROGRESS 2026-09-01

**Why this route and not a submission.** Terminal-Bench 4.0 community submissions are CLOSED —
`leaderboard/SUBMIT.md`: *"Only submissions run by the maintainers will be added."* The
leaderboard repo pins one dataset (`dataset_version_refs: ['4']`), so 2.1 is not a back door
either. A listed run therefore has to be executed BY a maintainer, which means Atlarix has to be
a pre-integrated Harbor agent. `CONTRIBUTING.md` is *"fairly liberal"* about agent integrations
and asks only that **one user of the agent** request it (precedent: harbor issue #2942, where a
commenter with `author_association: NONE` satisfied it the next day).

**The payoff is not only the leaderboard.** Harbor carries 100+ benchmark adapters (`swebench`,
`swebenchpro`, `swelancer`, `aider_polyglot`, `osworld`, `gaia`, `multi-swe-bench`, …). Upstream
the agent once and every one becomes `harbor run -d <dataset> --agent atlarix` — a standing
regression suite for the agent loop, independent of anyone reading a leaderboard.

**Done:** `npm i -g atlarix` is live (trusted-publisher OIDC from `headless.yml`, no
token in secrets); reasoning reaches the wire at the model's ceiling; the self-timeout is gone;
`--version` answers; `--trajectory-file` streams JSONL with secrets redacted.

**Owed:**
- `src/harbor/agents/installed/atlarix.py` in the fork at `../harbor`, plus `AgentName.ATLARIX`
  and `factory.py` — the only three touchpoints (verified by searching `AgentName.OPENCODE`).
  Mirror `opencode.py`: `ModelConnectionSpec(passthrough=True)`, `ensure_system_dependencies`,
  `nvm_node_install_snippet()`, `CliFlag`/`ErrorPattern`, `AgentCapabilities(atif=True)`.
- **The instruction must NOT go in argv.** `atlarix_tb/agent.py` passes `--prompt {escaped}`,
  which puts the task text in the agent's own `/proc/<pid>/cmdline`; harbor **#2311** documents
  agents killed by their own `pkill -f` this way — 15/15 trials, exit 143/137, each graded on a
  half-finished workspace. Route it env var → file → `--prompt-file`, as `claude_code.py` does.
- Port `benchmarks/` from `terminal-bench-2-1` to `terminal-bench/terminal-bench@4.0.0`, keeping
  `atlarix_tb` as a thin pin-proxy subclass (same shape as `pi_proxy.py` over `Pi`) so the
  opencode comparison still runs.
- **Keep `patch-harbor.py`.** The `upload_dir` `docker cp` bug it works around is still OPEN
  upstream (#202, #2686, #2043) and bites local-docker runs. Modal avoids it, and Modal is what
  Harbor's own CI and leaderboard use.
- Free k=1 smoke on ~10 tasks. Not for a score — to prove install, completion and a parseable
  trajectory before a maintainer spends donated compute on it.

**Owner action:** file the issue (harbor's Golden Rule requires the first AND last draft to be
human, with a disclosure that an agent wrote the code), then get one real user to comment.

**Four things only a REAL run found — unit tests passed through all of them.**

- **The inline tool tags carry ATTRIBUTES.** `<atlarix-tool-call tool="run_command"
  status="running">`, not `<atlarix-tool-call>`. A stripper anchored on the bare tag matched
  nothing a live stream produces, so the whole serialised call block was spliced into
  `assistant_text` as though the model had said it. Tests using bare tags passed.
- **A command's completion is announced TWICE.** The canonical `chat:activity` event carries
  `toolCallId` + `toolArgs`; a second one carries neither, nor a result. Recording it invents a
  tool call — six entries for four calls. A trajectory audit reads phantom calls as the agent
  having acted. Filtered at source in `trajectory-writer.ts`, deduped again in the adapter
  because that file's contract is the JSONL, not the writer.
- **`ensure_system_dependencies` takes KEYS, not package names.** `("make", "g++")` failed a
  real trial before the agent installed anything: `ValueError: Unknown system dependencies`.
  The key is `build_tools`, which maps per distro (build-essential on apt, build-base on apk).
- **No DeepSeek row existed in `byok-pricing.ts`**, so `turnCostUsd` was absent on every
  DeepSeek turn and a leaderboard cost column would have been blank. Added V4 Flash and Pro at
  their PEAK rates — the off-peak tariff is half, a static table cannot know which window
  applied, and on a published figure overstating is the safe direction.

**Still open, and worth knowing before a scored run:** `resultText` is populated for
`read_file` but NOT for `run_command`, so command OUTPUT does not reach the trajectory. The
leaderboard's reward-hacking judge reviews trajectories, and a run whose commands show no
output is weaker evidence than one whose do. Fixing it means touching how `build-branch.ts`
emits command activity, which is wider than this work.

### 🔍 OPEN — the sub-agent round panel renders twice

Not fixed (owner's call: cosmetic, and no cause was proven). The AGENTS are not duplicated — four ran
and `4/4 running` was correct; the PANEL appears twice, labelled differently each time. Candidates,
so the next attempt starts from evidence rather than re-deriving it:

- `mergeSubagentActivityIntoThread` falls back to a constant `roundId` of `"subagent-round"` when an
  event carries none, while the live path sends `roundId: ctx.turnId`
  (`register-delegation-tools.ts`). Two ids cannot merge — `upsertSubagentRound` keys on roundId.
- `synthesizeSubagentRoundFromParts` uses `"subagent-round-fallback"` — but it is guarded by
  `if (isStreaming) return null` (`AssistantMessageBody.tsx`) and the observation was mid-stream, so
  probably NOT this one.
- `stickyAgents` accumulates per `AssistantMessageBody`; two assistant bodies in one turn would each
  render the round.
- `consolidateSubagentRoundsInThread` DOES merge multiple rounds and runs on BOTH the live and
  completed threads — which is why the duplicate is most likely ACROSS message bodies, not within one.

The visible symptom is the labelling, and it names the two sources: `${agentRole} · ${scope}` from
the handoff path versus `subagentLabel()`'s `Sub-agent: Explorer`. **Start by instrumenting which
call site emits each panel** — every theory above is consistent with the screenshots, which is
exactly why none of them should be acted on yet.

**Owed before release:** verify in the PACKAGED app (a long real session, quit, reopen, confirm the
meter and the history start from the summary), then `/security-review` on the diff.


### OAuth redirect allowlist — OWNER ACTION, still owed

The code fix shipped in v14.38.4 (`AUTH_CALLBACK_URL` is now the canonical two-slash
`atlarix://auth/callback`, locked by `src/__tests__/oauth-redirect-allowlist-match.test.ts`). **It
does not reach builds already in the field**: v14.38.3 and earlier still send the three-slash
`atlarix:///auth/callback` and stay broken until they update.

Add **`atlarix://*/auth/callback`** to Supabase → Authentication → URL Configuration → Redirect
URLs, alongside the two-slash entry, and keep both until those builds are gone.

- **Not the literal three-slash string** — the dashboard's validator rejects an empty host.
- **Not `atlarix://**`** — that would also match `atlarix://mcp/oauth/callback`, making the MCP deep
  link a legal OAuth redirect target. Verified 2026-08-29 against `gobwas/glob` as GoTrue compiles
  it: `*` matches the empty host, so the narrow pattern hits the three-slash form and nothing else.
- **Not via `supabase config push`** — `supabase/config.toml`'s `[auth]` block is the LOCAL stack's,
  so a push overwrites the hosted Site URL with `127.0.0.1`.

**Why a non-match is invisible:** GoTrue matches the requested redirect as a literal string against
a compiled glob and, on a miss, silently substitutes the Site URL. Sign-in completes in the browser,
lands on the website, and the app is simply never launched.

### The repository list is live but the EXISTING installs are empty

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

### One non-owner run of the reviewer, end to end

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
- **Atlarix Reviewer is $19/dev/mo, unlimited repos.** No open-source exemption — that was an
  INTENT that was never built and was withdrawn 2026-09-04 (spec §8 Rev 4); the reviewer has no
  repository-visibility logic, so a public repo hits the same entitlement gate and the same wallet
  debit as a private one. Per developer is what the whole
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
- [ ] **Confirm `[prompt-cache]` still shows a large `read=` on later turns in a mode.**
      **PROMOTED 2026-09-02 — this now BLOCKS the v14.41.0 prose work** (see the header). The
      prefix is ~14,600 tokens in Build and sits inside one cache breakpoint; whether that is
      paid once or every turn is the difference between the remaining prose cuts being
      pointless and being the most valuable thing in the cycle. Core models get placement
      `"none"` (`anthropic-cache-breakpoints.ts`), i.e. we depend on the provider matching a
      byte-identical prefix — which is exactly the mechanism that fails silently. A `write=`
      that jumps every turn would mean the per-mode tool-description tiering is invalidating the
      cached prefix.

- [ ] **Passkey notice ACCURACY — and it never needed the Windows machine.** It sat under "Needs the
      Windows machine" until 2026-09-04, which is part of why it went unverified for weeks:
      `src/lib/browser/webauthn-notice.ts` is an injected BrowserView page script with **no platform
      check of its own** (the file says so), so it behaves identically on all three OSes and is
      verifiable on the dev Mac.
      The check is a **false-positive** check, not a feature test. No platform authenticator exists
      anywhere any more — Windows and Linux never had one, and macOS's went with the provisioned
      `keychain-access-groups` entitlement — so the notice is CORRECT to fire for an unstated
      request. It must **NOT** fire when a page explicitly asks for a roaming authenticator
      (`authenticatorAttachment: "cross-platform"`): a security key, or a phone over the hybrid/QR
      flow, goes through Chromium on every platform, and that phone is where the user's synced
      passkey already lives. Two earlier wordings of this message were wrong in **opposite**
      directions, which is why it is the TRIGGER being checked and not the text.
- [ ] **Linux: the notification SIGSEGV** in `electron::NotificationPresenter::RemoveNotification`
      (Fedora 44 Sentry report). Moved out of the Windows section 2026-09-04 — the fix is reasoned,
      not observed, and what it needs is a **clean Sentry week**, not a machine. Leave the app
      unfocused through several automation runs and let notifications expire rather than clicking
      them.
- [ ] **Sub-agent round dedupe has two UNPINNED paths** — found 2026-09-04 while fixing the
      double-render, and independent of that fix. `consolidateSubagentRoundsInThread` has **no test
      coverage at all**: nothing under `src/__tests__` or `tests` calls it. And
      `src/__tests__/subagent-card-settles-after-turn.test.ts:121` claims to pin "leaves a thread
      that does not own the sub-agent REFERENTIALLY identical" while its fixture **already contains
      a round** — so the case that matters is untested: `mergeSubagentActivityIntoThread` appending
      a fresh round into a **round-less** frozen thread, which the mount-level `onChatActivity`
      listener in `useStreamChat` does for every entry of
      `completedStreamThreadByAssistantMessageIdAtom` with no chat filter and no ownership check.
      Both are latent duplicate-panel sources. A fixture that already satisfies the condition it is
      meant to test is the same trap as a green assertion that asserts nothing.

## ✅ Windows/Linux verification — CLOSED 2026-09-04

Everything that once stood here is verified: Electron 43, process-tree kill, on-device voice
(Windows and Linux), the Windows Low-IL sandbox (`run_command` succeeds with git, so
`CreateProcessAsUserW` is not hitting `ERROR_PRIVILEGE_NOT_HELD`), the MSIX §4 behaviour check
including the protocol declaration, and Linux voice on the WebGPU-first path.

**The lesson worth keeping**, since it is why the section existed at all: its own preamble
admitted that counting these as backlog "made this queue read three times its real size", and two
of the items were **mis-filed as needing Windows** when neither did — the passkey-notice check is
a page script with no platform branch, and the Linux notification SIGSEGV needs a clean Sentry
week, not a machine. Both are in "Verification owed". Before filing something as blocked on
hardware, check that the hardware is what it is actually blocked on.

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
  `IS_SELF_TEST` guards that provably still short-circuit. **NOT Windows-only** — the same
  "all probes passed, process tree had to be killed" was recorded on macOS arm64 2026-09-05,
  on the PASSING path, which is the pattern rather than the exception.
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
- **Local packaged builds report `environment=production` to Sentry — KEEP, decided 2026-08-22.**
  `app.isPackaged` is true for a local ad-hoc build, so a developer machine reports as production.
  That was filed here as a defect with a fix attached (gate the DSN on a CI marker or the signing
  identity); the owner's call is to leave it, because local packaged builds are a deliberate
  diagnostic channel — some bugs are only findable through Sentry, and separating the environment
  would put exactly those runs where nobody looks. **This is settled, not pending.** The cost is
  accepted: production alert counts include the owner's own machine, so never read alert VOLUME as a
  user-impact signal without checking the source first.
- **8 conditional-hook violations, now VISIBLE but not blocking.** Enabling
  `react-hooks/rules-of-hooks` (2026-09-08, after a conditional `useMemo` shipped a
  React #310 white screen to the packaged app) surfaced 8 pre-existing ones:
  `useStreamChat.ts` ×4 — `useAtomValue` inside `if (hasChatId)` and a
  `hasChatId ? useProposal(id) : useProposal()` ternary; `SubAgentRunCard.tsx` ×2;
  `useWorkspacePlanPanel.ts` and `RightPanel.tsx` ×1 each (`useSearch` inside a
  `try`). They work today only because the condition happens to be stable for a
  component's lifetime — which is a property of current callers, not a guarantee.
  **`useStreamChat` is the risky one**: it is a core hook and changing its hook
  ORDER can break streaming, so it deserves its own pass rather than a drive-by.
  Set to `warn` so CI stays green and new violations are still caught; raise to
  `error` once these 8 are gone.
  Also switched OFF, as pre-existing debt worth its own decision rather than 100
  warnings drowning the 10 real ones: `react/set-state-in-effect` (58) and
  `react-hooks/exhaustive-deps` (25). The second is genuinely valuable and is the
  one to turn on next.
- **`useAuth` is an UNSHARED hook with 30+ consumers**, each running its own `checkSession()` —
  still the cause of repeated "Enforcing workspace limit" logs. Guard in the IPC handler, never in
  the hook. **The sign-out half is now scoped:** `SubscriptionManager.signOut()` does not broadcast
  `auth:resolved`, so only the instance that initiated a sign-out updates and a second window keeps
  a stale session. `broadcastAuthResolved()` already has no null-session guard (deliberately — that
  guard *was* the bug), so the fix is one call plus making `handleAuthResolved` clear `user`/`status`
  on a null user instead of early-returning. Do it with the rest of the unshared-hook work.
- **`ai@7`'s `instructions` placement is the aligned end state, not done.** `role:"system"` inside
  `messages` is re-permitted with `allowSystemInMessages: true` so the v10.1 prompt-cache layout
  stays byte-identical and measurable. Moving it into `instructions` (which accepts
  `Array<SystemModelMessage>`, so breakpoints could survive) needs its own commit and its own
  `[prompt-cache] read=` measurement.
- **Accepted advisories, with reasons rather than a shrug.**
  `@huggingface/transformers` → `onnxruntime-node` → `adm-zip` → `sharp` has no fix and is the
  deliberately-pinned voice stack. `shepherd.js` → `deepmerge-ts` (stack exhaustion on recursive
  merges) needs a major; the call site was checked rather than assumed — tour options are static
  literals in `TourManager.tsx`, so no attacker- or model-controlled object reaches the merge.

## 🔜 Blocked on the owner — not active work

- **2026-09-17 — GitHub Marketplace, chase it if Atlarix Reviewer is still not listed.** Three weeks
  after the App went public (2026-08-27), which is when GitHub's own guidance says to contact them.
  FIRST check <https://github.com/settings/apps> for rejection notes, requested changes, or a
  still-pending review — the answer is often already there. If there is genuinely no communication,
  file at <https://support.github.com/contact> → *What can we help with?* → **Marketplace** →
  *"App review pending for X weeks, no updates received"*, including the app name, App ID, the
  GitHub org/account used to submit, and the SUBMISSION date (which may differ from the date the
  App went public).
- **`build-msix` must `needs: build-linux`.** It declares `needs: [quality]` but genuinely
  depends on `build-linux`'s `landlock-helper` artifact — `msix.yml:220` downloads it with
  `continue-on-error: true`. On v14.43.0 they raced and MSIX lost: msix started 09:24:58 and
  failed 09:28:27, while build-linux did not upload until 09:32:12. The download failed
  silently, `forge.config.ts`'s `existsSync` guard dropped the helper from `extraResource`
  without complaint, and only the NEW `EXPECTED_RESOURCES` check turned it red.
  **This is a latent bug the assertion caught on its first CI run** — before it, every Store
  build that lost this race shipped without WSL confinement, green and silent. One-line fix;
  a job re-run was the correct recovery for the release itself, but the race remains.
- **Un-pin the Windows runners from `windows-2022`, once a dispatch proves it.** The blocker
  is fixed: `patches/@electron+node-gyp+10.2.0-electron.1.patch` now maps VS major 18 to year
  2026, adds 2026 to all three `supportedYears` arrays, and discovers the VC++ toolset by
  scanning `<vsPath>\MSBuild\Microsoft\VC\*\Platforms\x64\PlatformToolsets` rather than
  hardcoding a `vNNN` (the year→toolset map is NOT derivable from the MSVC version — VS 2022
  17.14 ships MSVC 14.44 and is still `v143`). What is missing is a green run: nobody here has
  a machine with VS 2026, so it is unexercised code on the path that takes out `build-windows`
  AND `build-msix` at once.
  **Next step:** dispatch `Atlarix MSIX` with the new `runner: windows-latest` input (needs the
  repo flipped public for the Actions budget, same as a release), and read the printed
  `versionYear` / `toolset` from the "Verify Visual Studio toolchain is discoverable" step.
  That step exists because the obvious verification does not work: `@electron/rebuild` buffers
  node-gyp's output and prints it only on a non-zero exit, so on a green build there is no log
  and "assert the ABSENCE of `unsupported version: 18`" is vacuously true. Only after that
  dispatch is green do `msix.yml`'s two defaults and `release.yml:build-windows` change.
  `src/__tests__/node-gyp-vs2026-patch.test.ts` guards the patch from evaporating on a bump.
- **Windows code-signing cert** — native-sandbox CI, and the only real fix for the C6 residual on
  direct-download Windows. Release infra, no cert. The helper sign step is wired; set the secret.
- OAuth `state` nonce / PKCE stays **not doing** — attempted v14.12.0, broke sign-in, reverted. The
  flow-in-progress gate stays. Revisiting needs confirmation that the Supabase redirect-URL
  allowlist permits a query param.

## 🔐 Security — reviewer, money path and app hygiene ALL CLOSED (2026-08-30)

**One document remains, deliberately OUTSIDE every repository** (these repos flip public for CI):
`../SECURITY_SECRETS_2026-08-28.md`, the leak-response note.

**The two audit write-ups were verified closed and DELETED on 2026-08-30.** Every finding was
re-checked against the code first, not taken from the status column: `safeRepoPath` guards both
`PrContext` implementations, `MAY_REQUEST_REVIEW` gates the mention, the per-prompt nonce and the
scoped installation token are in place, `isRepoFullName` is at both entry points — 196 reviewer
tests green. The lessons that outlive the findings are kept below; the exploit write-ups are not
kept, because a repo whose visibility toggles is not a home for them and they had served their
purpose.

**App hygiene (the last open item) — fixed and SHIPPED in v14.39.0 (`0a7bb027`):** the three identical
`atlarix://mcp/oauth/callback` branches in `handleDeepLinkReturn` are one branch again (two were
unreachable — a fix could have landed in a copy that never runs), and `preload.ts` lost the
`// Test-only channels` comment that sat above the LIVE Build-mode permission channels plus seven
within-list duplicate entries (the audit said three; it undercounted). No channel was lost:
`validInvokeChannels` 281 → 276, `validReceiveChannels` 83 → 81, both now duplicate-free, with
`ts:main` and all 3,470 tests green.

**The `users` INSERT policy is APPLIED — this section has no open item.** `20260828090000` shows
local == remote in `supabase migration list --linked` (verified 2026-08-29). It closes the hole where
an account whose row was missing could insert itself as `plan='pro'`.

**Secrets: there is now a leak-response note**, not a rotation schedule — the question it answers
is "this key just leaked, now what", which nothing answered before. Three credentials matter:
the **GitHub App private key** (every installation; GitHub allows two keys, so rotation is
zero-downtime), **`AZURE_AD_CLIENT_SECRET`** (publishes to the Store — load-bearing for update
integrity precisely BECAUSE C6 was closed on the Store's behalf), and the **Supabase
`service_role`** (four consumers, so rolling it needs an order).

### Lessons kept from the reviewer audit — and what is still unaudited

Owner scoped the pass to **`atlarix-reviewer` only**, audited by hand. Five findings, all
five fixed in `atlarix-reviewer@edc457e` and re-verified against the code on 2026-08-30.
**The write-up was kept OUTSIDE every repository and has since been deleted:** the reviewer
and proxy repos get flipped public to run CI past the Actions budget block, so a repo whose
visibility toggles is not a home for a live exploit write-up. That is a general rule now, not
a one-off — and it is why the lessons live here rather than in a file beside the code.

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

**Residual 3 — CLOSED, and it was already closed when this was re-read 2026-09-07.** The service
path authenticates with a service token and names the payer in `x-atlarix-account-id`, because a
pull-request webhook fires with nobody signed in. The proxy no longer takes that header's word:
`accountHasInstallation` (`atlarix-proxy/src/entitlement.ts`) asks `github_installs` whether the
claimed id owns a live install (`removed_at IS NULL`), cached 5 minutes, and `server.ts` refuses
with `account_not_bound` when it does not. A failed CHECK returns 502, not 403 — "we could not
check" is our outage and must be retryable, while "not bound" is an answer. Four tests under
"the account must own a live installation" cover it, including that the check runs against the id
the HEADER named and does not run on the user path.

That does not make the token less of a bearer secret; it means holding it is no longer enough on
its own, and a leak's blast radius drops from every account to accounts that have actually
installed the app. The repo-level check is deliberately NOT done: `github_installs.repositories`
still reads empty on both live installs, so gating on it would fail closed on real traffic. Worth
having once that set is backfilled — see the repository-list item.

**What would change the picture:** any of these becoming real needs a *measurement* first — the
Supabase request count is the tell, and the 2026-08-26 lesson was that 704 requests/hour looked like
the website and was actually a 5-second poll. Do not scale on a hunch.

## ☁️ Cloudflare — DNS MIGRATED 2026-09-01; one thing left

Landed: DNS on Cloudflare, **grey-clouded deliberately** (Vercel advises against a proxy in front
of it — it intercepts their ACME path and breaks cert renewal, and every free-tier WAF /
rate-limit / Bot-Fight feature is proxy-gated, so grey-clouding forgoes nothing we could have
used); **DNSSEC**; the **apex SPF** that was missing entirely; and **DMARC reporting**, which had
been `p=none` with no `rua` and so monitored nothing.

- [ ] **DMARC `p=none` → `p=quarantine`**, after 2–4 weeks of reports. Time-gated, not
      effort-gated. Not before — enforcing without data is how legitimate mail starts landing in
      spam.

**Deliberately not doing:** Workers, Pages, Zero Trust, Images, and **proxying the Railway origin**
(`api.atlarix.dev`) — Cloudflare in front of a streaming SSE endpoint can buffer or time out and
break token streaming for every desktop user. If that is ever revisited, do it alone and make a
real streaming turn the acceptance test; `/health` would pass either way.

**Turnstile — CLOSED 2026-09-01**, and not the way it was framed. What was actually happening:
email/password signup was ENABLED on a project that never uses it, so `POST /auth/v1/signup` →
confirm through a disposable inbox → `claim_signup_credit()` paid $1 without ever touching our UI.
23 claims, $23. Closed twice on purpose — the dashboard toggle (Email off) AND
`20260901100000_trial_credit_requires_oauth_identity.sql`, which refuses the grant unless
`auth.identities` holds a non-email provider row. The toggle alone was not enough: it exists only
in the dashboard, `supabase/config.toml`'s `[auth]` block is the LOCAL stack's, and re-enabling it
would reopen the hole with nothing in the repo to show. **A payout rule belongs next to the
payout** — and not as an allowlist of provider names, since adding a fourth provider later would
silently stop paying the credit and nobody reports a dollar they never knew existed.

- [ ] **Trial-credit residual — open, not urgent at $23.** The dedupe key is
      `(kind='trial', ref=user_id)`, so the scarce thing is an account, and Google/GitHub accounts
      are free. The durable answer ties the grant to something costlier — a payment method, or
      account age — not a challenge; Turnstile could not have helped regardless, since that signup
      happens on Google's site. The owner separately wants the credit raised to ~$5 "gated on a
      verified account", which is the same decision from the other end. **Decision first, then
      code.**

## 🔐 Security follow-ups — owner-triaged, deferred

The v14.8.12 review document was deleted once acted on (`b48002a6`). Fixed by v14.8.13: compound
danger gate, exfil taxonomy, deep-link auth-CSRF, MCP consent gate, `.atlarix` authority-file
approval, MCP description wrapping + OAuth-URL validation, the universal write-confining sandbox
(Windows since rebuilt on Low IL), and the system-scope approval gate (which also closed M1).
**Deferred:**

- **C6 — auto-update signature verification.** Moved: see **CLOSED — do not re-propose**, which
  records it as closed for the path that matters (2026-08-28) along with the residual. It was listed
  in both places with opposite verdicts.
- **Native sandbox validation in CI.** The Windows/Linux helpers cannot compile on macOS.
  `npm run check:sandbox` cross-target type-checks both and the helpers are gated on behaviour, but
  neither substitutes for running them on the real OS.
- **Unattended read-only allowlist-flip** (a positive allowlist for automation runs) — the denylist
  taxonomy is done; the flip needs per-automation design to not break legitimate builds and tests.
- Sandbox **read**-confinement (Windows blocker above), **egress** gating, and the remaining Mediums:
  env-var key inheritance, secret-basename list, cross-workspace file scope, plaintext-keychain
  fallback.

## 💤 CLOSED — do not re-propose

- **C6 — auto-update signature verification. CLOSED for the path that matters, 2026-08-28.**
  Verified in `src/main.ts`: `chooseUpdaterKind` returns **`"none"`** for an MSIX install, and the
  Microsoft Store signs and delivers that package itself. Most users are on the Store, so C6 does
  not apply to them and the owner closed it.
  **The residual, recorded so it is not mistaken for zero:** direct-download Windows (Squirrel, and
  those builds are unsigned) and Linux AppImage still auto-update with nothing verifying the
  binary. The real fix there remains a code-signing cert and an out-of-band AppImage signature.
  **And not to be overrated either:** assets come from GitHub over HTTPS, so "intercept the
  download" needs a broken TLS chain. A signature defends against a compromised RELEASE CHANNEL,
  which is a narrower threat than the original framing implied.
  **One consequence to hold on to:** closing C6 on the Store's behalf makes
  `AZURE_AD_CLIENT_SECRET` load-bearing for update integrity — it publishes to the listing. See
  the secrets note.
- **Atlarix GitHub account for contributor credit. CLOSED, owner's call 2026-08-28.** Purely
  cosmetic attribution, one more account to hold and secure, and the code side needs nothing.

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

### A silent zero is the failure mode to design against, twice over

Both of this cycle's real bugs returned a plausible-looking ZERO instead of failing.

**The prompt-budget measurement.** Tools register themselves only as a side effect of
importing `lib/tools/index`; nothing calls an `initializeTools()` at startup (its log line
never appears in a packaged boot). `resolve-toolset` imports `ToolRegistry` from
`./registry` DIRECTLY, so it does not pull the index in — meaning the meter could resolve
zero tools and report a prefix of zero tool tokens without throwing. It under-reported by
~10,000 tokens and looked exactly like a saving. **Caused by a dead-code report:** knip
flagged an unused helper, and removing it took the load-bearing side-effect import with it.
Now: the import is back with a comment saying it must not be cleaned up, an empty surface
THROWS (the caller already degrades that into a visible warning), and
`prompt-budget-registry.test.ts` deliberately does not import the index so its absence is
the assertion. **A dead-code report cannot tell a load-bearing side-effect import from
noise — check what an "unused" import was holding up before deleting it.**

**The token budget cap.** `localValue` used `""` for two states — "not editing, show the
saved value" and "the user cleared the field" — so clearing put the saved number straight
back. The only way out left a literal `0` on screen, which then failed a `> 0` check and
silently deleted the override: the field displayed a cap of zero while the provider was on
automatic. **Two states sharing one spelling, and the display disagreeing with the stored
value.** Reported by the owner, not by any test. When a control has an "unset" state, give
it its own value (`null`), and have the UI SAY which state it is in rather than leaving an
empty box to be interpreted.

The general rule: an error is a gift, a zero is a trap. When a measurement can legitimately
be small, make the impossible case throw.

### A meter that measures the wrong thing is worse than no meter

Found 2026-09-02 while sizing the prompt. Three faults in one function
(`token_count_handlers.ts`), and the shape of them is the lesson.

**It measured what it BUILT, not what dispatched.** It called `constructSystemPrompt` and
stopped — no tools array — so it reported ~4,000 tokens against a real fixed prefix of
~15,300 in Build. The tool DESCRIPTIONS (4,183) and, larger, the parameter SCHEMAS (5,747)
are inside the same cache breakpoint and billed on every turn, and nothing had ever counted
them. `tool-reveal.ts` had reasoned carefully about descriptions being the cost, which was
true when it was written and had since stopped being true.

**It re-derived a decision the dispatch already makes.** It hand-rolled work-mode resolution
instead of calling `resolveEffectiveWorkMode`, and yielded `undefined` whenever
`intentMode === "auto"` — which sends the prompt builder down its legacy all-five-modes path,
a shape whose own dev warning says "never use for live streams". **When two places answer the
same question, one of them is wrong and you will not find out from either.**

**It read global state for a per-session decision** (`settings.workModePreference`, when
`chatSessions.workMode` has owned it since v14.36.0) — the third instance of that class.

The fix that matters beyond this bug: the budget eval reads `body.messages` + `body.tools`
off the FAKE SERVER's recorded request. That is why it can be trusted, and it also revealed
that a real dispatch runs ~1,100 tokens ABOVE a bare builder measurement (mode reanchor +
ContextAssembler pointers) — a gap no amount of calling the builder directly would have shown.

### The advertised schema and the runtime guidance have to agree

`read_file` advertised three paging schemes (`max_lines`, `start_line`+`end_line`,
`offset`+`limit`) — 1,269 chars of schema against a 226-char description, on the most-called
tool in the app. Collapsing to `offset`/`limit` was easy; the part worth remembering is that
its own truncation FOOTERS still said "lower `max_lines`" and "use `start_line`/`end_line`",
i.e. the tool was telling the model at runtime to use parameters it could no longer see.
`background_jobs`' description named `job_id` five times over after the same change.
**Grep the tool's own output strings whenever you change its schema.**

### Advertising a parameter the harness overwrites is worse than free

`grep.workspace`, `grep.workspaceId`, `plan.workspaceSessionId`, `automations.workspaceId`,
`session_search.workspaceId` were all in the model's schema. The turn runner injects them by
spreading `...tc.args` and THEN overwriting, so whatever the model sent was discarded — it
paid tokens for parameters it could not affect and was invited to guess a workspace id.
`chatMode` and `_chatSessionId` were already injected without being advertised, so the right
pattern existed in the same file. Saving: ~290 tokens in Build. The point is the surface, not
the tokens.

### `git grep` found the handlers; it did not find the tools

Auditing the retired `"global"` scope, I checked `mcp_handlers.ts`, found every read filtered
on `scope = 'workspace'`, and said so. **Wrong.** `lib/tools/mcp.ts` had two more sites and
`lib/workspace/workspace-capabilities.ts` a third, and one had a live consequence:
`listConfiguredMcps` with no workspace queried `scope = 'global'` ALONE, and since those rows
were purged by migration 0049 and nothing can create one, `list_available_mcps` returned an
empty list through a query that could never match. Both MCP tools are
`requiresWorkspace: false`, so that path is reachable. Empty was the CORRECT answer and it was
arriving by accident. **When you conclude "every call site does X", name the files you looked
in — the ones you did not name are the ones that bite.**

### SQLite has no `ALTER COLUMN SET DEFAULT`

`mcp_servers.scope` still defaults to `"global"`, the retired value — a latent trap, since
every read filters `scope = 'workspace'` and an insert omitting it would save a server that is
then invisible with nothing to explain why. It is unreachable (both insert paths bind it), and
it STAYS, because flipping a default in SQLite means rebuilding the table — the same cost as
dropping the column. Changing it in `schema.ts` without a migration would be worse still: new
installs would get one default and existing ones the other, so the schema would describe
neither. Same reasoning keeps `installed_skills.scope`, which is part of a composite primary
key. **Narrow the TYPES, leave the columns.**

### A comment asking people to remember is not a control

`SettingsList.tsx` opened with a comment saying an entry with no matching section "is a dead
link that silently does nothing", and cited `team` as a past instance. Then the per-project
move deleted the `workflow`, `mcp` and `skills` sections — and would have left three more
dead entries, for exactly the reason the comment described. `settings-nav-parity.test.ts` is
the control now (and was verified to FAIL against a reintroduced dead entry before being kept).


### Moving DNS: the zone is bigger than the zone you can see

Migrating `atlarix.dev` to Cloudflare, 2026-09-01. Zero downtime, and the technique is the reason.

**Cloudflare answers for the zone the moment it is created, BEFORE the registrar is touched.** So
both authoritative sources can be diffed while production is untouched, at zero risk:
`dig @perla.ns.cloudflare.com … ` vs `dig @dns1.registrar-servers.com …`, every name and type. Do
that until it is clean, and only then flip. Normalise TXT chunking (`sed 's/" "//g'`) or a DKIM key
split into 255-char segments reads as a DIFF when the value is identical.

**A zone cannot be enumerated from outside — export it from the registrar.** `dig` can only confirm
names you already guessed. Namecheap also **paginates and hides records behind "SHOW MORE"**, and
what it hides is DKIM/SPF/DMARC — exactly the set whose loss is invisible. Our zone had a whole
`send.atlarix.dev` delegation (Resend, which fronts SES) that no reconstruction would have found.

**Rank the records by how loudly they fail.** SPF/DKIM loss shows up as spam-foldering within days.
Losing Resend's **bounce-feedback MX** shows up as nothing at all, while sender reputation decays
over weeks. Resend provisions that subdomain on every domain, so treat it as a checklist item.

**DS after signing, never before.** Publishing a DS at the registrar while the zone is unsigned tells
every validating resolver to reject unsigned answers for a zone that only has unsigned answers —
hard failure, not degradation. Enable DNSSEC at the DNS provider first, then paste the DS.

**Check for a stale DS before flipping at all** (`dig +short DS <zone>`) and confirm the algorithm
dropdown matches what the provider actually signs with — Cloudflare uses 13/ECDSAP256SHA256 with a
SHA-256 digest, and a registrar UI's first dropdown entry is `1 RSA/MD5`. A mismatched DS validates
against nothing. Prove the chain closed by the **AD flag** on a real query, not by the dashboard:
Cloudflare's own panel still said "pending" for an hour after four resolvers were validating.

**Vercel stays DNS-only forever.** A proxy in front intercepts the ACME path and breaks their cert
renewal, and there is no origin IP to hide — their addresses are shared anycast. On the free tier
every WAF, rate-limit and challenge feature is proxy-gated, so grey-clouding forgoes nothing usable.
Corollary for anything non-HTTP (WebRTC, SSE): it must stay DNS-only too.

### An anon key is a public credential — enumerate the SERVICE, not your call sites

Proven on ourselves, 2026-09-01. Both products use `signInWithOAuth` exclusively and have no
email-auth call site anywhere, from which I concluded email signup was closed. It was not: the
project had `"email": true, "disable_signup": false`, and the anon key that reaches it ships inside
the app binary and the website bundle. **What your client calls places no limit on what anyone else
can call with the same key.** The cost was a `$1`-per-account payout claimable without ever touching
our UI.

The check is one read-only request — `curl -H "apikey: <anon>" https://<ref>.supabase.co/auth/v1/settings`
— and the general form is: enumerate the exposed surface from the SERVICE (auth settings, function
`GRANT`s, RLS policies, edge-function `verify_jwt`), never by grepping our own code. A capability
nothing in the repo uses is still a capability.

Its mirror, which is how this hid: having correctly established that Turnstile cannot attach to an
OAuth redirect, I stopped. **Auth flow and money flow are different questions** — the next one was
"what else pays out per account?"

### Turnstile needs an endpoint that accepts a token

A pure OAuth/OIDC redirect has nowhere to put one — `signInWithOAuth` takes no `captchaToken`, and
the provider's own login page is where bot defence actually applies. Before budgeting the work, ask
"does any auth endpoint take a credential in a request body I control?" If not, the item **closes**
rather than defers. The trap is answering "add a CAPTCHA to login" without checking the auth *shape*
— and its mirror, which caught me here: having concluded that, do not then assume there is nothing
to protect. `claim_signup_credit()` is an RPC that pays out real money per account and *could* carry
a token. Auth flow and money flow are different questions.

### A `sql` template does not qualify its columns — a subquery can silently self-compare

`sql\`select count(*) from ${sessionMessages} where ${sessionMessages.sessionId} = ${chatSessions.id}\``
renders BOTH sides unqualified: `where "session_id" = "id"`. Inside the subquery both names resolve
against `session_messages`, which has its own `id`, so every row compared its `session_id` to its own
`id` and the count was **structurally always zero**. It returned a plausible number, never threw, and
drove a delete. Use a `leftJoin` + `groupBy` where the query builder qualifies for you; if a raw
template is unavoidable, write the table prefixes by hand and test the count against a seeded row.

The general form: **a query that returns a WRONG number is worse than one that throws**, and an
aggregate is the easiest place to get one. Any count that gates a destructive action gets a test with
a known answer.

### A fixed token constant is a bug waiting for a smaller window

Compaction accumulated five of them — 20,000 / 20,000 / 8,000 / 40,000 / "3 turns" — each sensible
against a 1M window and each one an automatic no-op against 16,000. Nothing failed; every step just
declined, and the feature looked implemented while doing nothing. Anything compared against a token
count must be a proportion of the budget in play, and the invariant to assert is that **no protection
floor exceeds the budget it protects within**.

Its sibling: a threshold expressed as a PERCENTAGE of the window cannot express "leave room for the
reply", because reply length has no relationship to window size. Subtract a real reserve
(`maxOutputTokens` from the catalog), clamped so it cannot invert.

### `"x".repeat(n)` is not a large fixture

BPE collapses a run of one character to a couple of tokens, so a 70,000-character fixture built that
way scores ~300 and every size assertion around it is vacuous. Build fixtures from varied text, and
MEASURE them rather than assuming chars ÷ 4.


### An audit list is not the runtime gate

`tool-registry-audit.ts`'s `GLOBAL_CHAT_TOOLS` exists so a chat-scoped tool does not trip
"registered but not on any mode allowlist". It has NOTHING to do with whether the tool is offered:
`isToolAllowedInMode` reads per-mode sets built from `EVERY_MODE_TOOLS` in `mode-tool-registry.ts`.
Adding `session_search` to the audit list alone left every check green — `auditToolRegistry`,
`tool-activity-labels-coverage`, the typechecks — while the tool was invisible in ask/plan/review.

The general form: when a name appears in two lists, find out which one the RUNTIME reads. The check
that catches it is `toolset-golden.eval.test.ts`, because it resolves the surface actually handed to
the model rather than any list's opinion about it. If a new tool does not change that golden, it is
not reachable.

### A durable format must be pinned as a LITERAL, not as its own constant

`expect(COMPACTION_SUMMARY_PREFIX).toBe(COMPACTION_SUMMARY_PREFIX)` is the shape a lot of
"format" tests accidentally take: importing the constant and comparing against it means a rename
moves both sides and the test stays green. `[COMPACTION MARKER]` is already written into users'
`session_messages` rows — renaming it would leave every existing session unrecognised and silently
re-expanding its full history on reopen. Anything that has been WRITTEN TO DISK gets asserted as a
literal string, and changing it needs a migration.

Corollary, learned the same hour: after writing a test for a bug, break the fix on purpose and
confirm the test fails. Three mutations were tried here; the first version of the suite caught two.


### The local typecheck and CI's typecheck are DIFFERENT PROJECTS

`npx tsc --noEmit -p tsconfig.json` passes on code that `npm run check:ts` rejects. CI runs the
latter, which is `tsc -p **tsconfig.app.json**` — and that is the project that covers
`src/__tests__/renderer/**`. A widened string literal in a renderer test passed a full local gate
(378 files, 3381 tests, `check:sandbox`) and then failed `quality` on the release push, 2026-08-29.

**Run `npm run check:ts`, not a hand-rolled `tsc -p tsconfig.json`.** The launchpad has the mirror
of this and its own note says so: "typechecked with tsconfig.app.json — the root tsconfig does not
check src". Same shape, two repos. A gate that does not run CI's own command is not the gate.


### An audit line that RE-DERIVES a decision will eventually state the opposite of it

`[SYSTEM-SCOPE-AUDIT]` printed "(runs unsandboxed)" whenever `preview.systemScopeInteractive` was
true. `buildRunCommandSandbox` applies a SECOND condition — a command that is system-scope only by
path keeps the sandbox and widens `extraWritablePaths` — so both spellings landed in one live log a
millisecond apart, the audit claiming the opposite of what happened. It now logs from the builder's
return value, which also lets it describe the three other ways the sandbox legitimately comes off
(`ATLARIX_DISABLE_SANDBOX`, `sandboxRunCommand: false`, no workspace) that the old wording could not.

Sibling of "a comment claiming containment is not containment", and worse in one respect: a comment
misleads whoever reads the code, an audit line misleads whoever is reconstructing an incident, which
is the moment you can least afford it. **Any log asserting a security property must read the value
that decided it, never recompute the condition.**


### A tool's own enum must be MAPPED, not compared against two values

`buildDiffView` decided the diff label with
`operationRaw === "create" || operationRaw === "delete" ? operationRaw : oldContent ? "update" : "create"`.
`edit_file` emits `write | replace | merge`, so **every** edit fell through to the guess, and an edit
whose content had not been extracted was labelled a CREATE of a NEW FILE. Wrong in the worst
direction: a create is the card you skim past in Build mode.

**Why the tests did not catch it:** every existing case passed `operation` explicitly in the RESULT
payload, so the enum branch was never exercised. The real result carries only success and line
counts — the tool's `operation` ARG is the only source, and that was the discarded one. When a test
supplies a field the production payload does not, it is testing a shape that never occurs.

Sibling of the "Runned <tool>" label trap: a new tool needs LABELS/DONE_LABELS and an expand-view
branch — and now also a mapping for every value of its own operation enum.


### The prompt stated no workspace root, so an agent inverted the memory slug into one

Observed 2026-08-29. An agent in `/Users/…/Github/supabase-auth` spent six tool calls against
`/Users/…/Github/supabase-auth-jdv5y5`, which does not exist. Atlarix was right at every layer — the
cwd, the interceptor and the workspace binding all logged the real path. The invented one came from
the MEMORY directory: `workspaceSlug()` renders the workspace path with `/` → `-` and appends a djb2
hash, so `Users-amariah-Documents-Github-supabase-auth-jdv5y5` reads exactly like a project path with
a suffix — and it was the only absolute path in the prompt naming the project.

**The fix was one added FACT, not a guard.** `workspacePath` reached the prompt builder and was spent
entirely on internals (project instructions, docs hint, `memoryDir`); it is now printed as
**Workspace root**. `tool_contract` had been telling agents that an absolute path is the only spelling
that reaches outside the workspace while giving them no root to build one from.

**And the honest scope, because the logs were checked before writing anything:** DeepSeek V4 Pro ran
**7 turns across three workspaces with no memory store** — the exact risk condition — and never did
this. The single inversion was `openrouter/openrouter/free`. A first draft of the fix also added ~60
tokens of hedging to the memory line ("this is a store, not a path within the project…"); that was
reverted. **Paying for defensive prose in the cache prefix on every turn of every user, to argue with
one weak model's inference, is the surface growth the harness filter exists to stop.** State missing
facts; do not argue with bad guesses.


### A redirect Supabase does not recognise is not refused — it is REPLACED

GoTrue compiles every Redirect-URLs entry into a glob (separators `.` and `/`) and matches the
requested `redirect_to` as a literal string. A miss falls back to the **Site URL**, silently, with a
200 the whole way. So a one-character allowlist difference presents as "sign-in does nothing" with
no error to grep for, in the app, the browser, or the Supabase logs.

**And it cannot be probed from outside.** `/auth/v1/authorize` echoes whatever `redirect_to` you
hand it into the provider URL — `https://evil.example.com/x` is echoed back verbatim — because
validation happens later, at `/auth/v1/callback`, against a flow-state row keyed by an opaque UUID.
Confirmed by hand 2026-08-29: the echo proves nothing. The only honest check is the allowlist
itself, byte for byte, against the string the client actually sends.

**The generalisation:** a redirect URI is a shared constant that lives half in a dashboard nobody
diffs. Whenever one is built by concatenation, print it and compare it to the allowlist entry
character by character — `://` + `/path` is two slashes plus one.


### Deleting railway.toml FLIPS the builder — an 8-minute outage

Migrating to `.railway/railway.ts` on 2026-08-28, the toml was deleted. It contained
`builder = "nixpacks"` while the SERVICE's persisted setting was **RAILPACK** — the file had been
overriding it at every deploy. Deleting it flipped the builder. Build succeeded, healthcheck
passed, and every Supabase call then failed with **"Node.js detected but native WebSocket not
found"**, because it is a different runtime image. Every Core request 502'd for eight minutes.

**`railway config pull` captures what the SERVICE holds, not what a file was OVERRIDING.** The
pulled config said RAILPACK — accurate about the service, wrong about production. `startCommand`,
`healthcheckPath` and `healthcheckTimeout` were null on the service too and lived only in the toml.
**Diff the toml against the pulled file by hand before deleting it.**

**And the debugging lesson, which cost more than the fix:** I chased the npm dependency I had just
added, then the Node version, because both changed in the same window. Neither was it. **When
something breaks right after a migration, suspect what was REMOVED before what was added.**

### The MSIX build races npm publication — `--no-package-lock` installs "whatever is newest"

v14.38.3's MSIX job failed with `notarget @ai-sdk/openai@4.0.51` against a version published
**seven seconds earlier** (17:29:01Z published, 17:29:08Z failed): npm saw it in the packument and
the tarball had not reached that runner's CDN edge. **Re-running the job fixed it**, which is the
tell for this class — a build that fails on a specific version number and passes unchanged minutes
later is a propagation race, not a broken dependency.

**But the race is the symptom.** `packageAfterPrune` installs with `--no-package-lock`, so every
root resolves its semver range to whatever is newest at that instant — meaning the packaged binary
was shipping versions nobody tested, since `npm test` runs against the lockfile. Fixed on `dev`
(`61d519f8`): each root installs as `name@version` read from `package-lock.json`.

**THE MSIX SHIPS ON EVERY RELEASE. It is not optional and must never be described as such.**
Owner's rule, 2026-08-28. It was absent from `publish-release`'s `needs`, which is why v14.38.3
published to macOS, Linux and Windows while Store users — the MAJORITY of users — got nothing, off
a run that looked green. `build-msix` is now in that `needs` list, so a release cannot publish
without it. The trade is deliberate: a Store outage now blocks the desktop publish too, and that is
the right direction — a release that reaches some platforms and silently skips the biggest one is
not a release. Recovery is a job re-run, not a new tag.

**And the diagnostic habit:** when a build breaks right after unrelated changes, get the
publication timestamp before suspecting your own diff — `npm view <pkg> time --json`. It cost one
command here and would otherwise have cost a Windows build cycle chasing two innocent
dependencies.

### A failed CI check suite silently SKIPS the Railway deploy

**Found 2026-08-28, and it had been happening since 2026-08-25 with nothing saying so.**
`atlarix-proxy` had not deployed for three days. `/health` answered, `/v1/models` returned the
right lineup — and both were lies about the build, because `/v1/models` is served from
`core-models.json` fetched at runtime, not from the code. The deployed commit was `78ac05c`.

The reason is exact, and Railway will tell you if you ask:

```
railway api 'query { deployment(id: "<id>") { meta } }'
  -> skippedReason: CI check suite failed
```

**The chain: the GitHub Actions budget block fails CI on every PRIVATE repo →
Railway sees a failed check suite → it SKIPS the deploy.** Status reads `SKIPPED`, not `FAILED`,
and nothing surfaces it. So the Actions budget problem is not only about red badges; it silently
stops shipping.

**Two consequences for the flow:**
- **Flip the repo public BEFORE the push, not after.** Railway evaluates the check suite as it
  lands; a CI run that goes green later does not retrigger the deploy.
- `railway redeploy` **redeploys the last deployment's commit**, which is the OLD one — it looks
  like it worked and changes nothing. `railway up` deploys the working tree and is the way out.

**And the general lesson, which is the expensive half:** `/health` returning `ok` proves a process
is running, not that it is running YOUR code. Verify a deploy by the BEHAVIOUR the change
introduced — a new endpoint, a new header, a new refusal — or by reading the deployed commit
(`railway status --json`, `meta.commitHash`). I claimed the account-binding gate was live on the
strength of `/health` and `/v1/models`; it was not, for three hours.

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

- **The Supabase CLI reports BOOKKEEPING, not behaviour — and its "nothing to do" is indistinguishable
  from its "already done".** 2026-09-01, applying the trial-credit gate: `supabase migration list`
  showed the new version in both the local AND remote columns, and `supabase db push --dry-run` said
  `{"upToDate":true,"migrations":[]}`. Both readings are exactly what you would see if the migration
  had silently never applied. A row in `supabase_migrations.schema_migrations` is a claim that the
  file ran, not evidence that the objects changed. **Verify against the database.** `supabase db
  query --linked` exists and needs no password:

      -- did the body actually change?
      select position('<a token unique to the new body>' in pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = '<fn>';

      -- and did the grants survive? (see the PUBLIC trap below)
      select array_to_string(p.proacl, ' | ') from pg_proc p … ;

  A correct-looking `proacl` is `authenticated=X/postgres | service_role=X/postgres` — a bare
  `=X/postgres` entry with no role before the `=` IS the PUBLIC grant.
- **After ANY `CREATE OR REPLACE` of a DEFINER function, read `proacl` back.** Postgres re-adds the
  default PUBLIC grant on replace, so a migration written to NARROW a function widens it unless the
  `REVOKE … FROM PUBLIC` is re-asserted — and the migration succeeds either way. This is how
  `credit_wallet_service` became callable by anon (20260714150000). Re-asserting the revoke is half
  the fix; confirming it stuck is the other half.
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
| **v14.39.1** | The compaction summary hidden from the chat and from `session_search`; the marker identified by a DB column instead of its first bytes; telemetry stopped writing before consent; error reports disclosed; every public data claim reconciled with the code | A comment is not a control: `showExtraFilesToast` opened with "NEVER send `files` — these are absolute paths" and then sent git's raw error, which quotes those same paths. `before_send` dropping events is not the same as writing nothing — `posthog.init` writes a distinct id to localStorage **and** a cookie before consent exists; gate INITIALISATION, not `persistence`, or you re-break `$session_id` continuity. A durable record must be identified STRUCTURALLY: `flattenNativeForCompaction` renders tool results as `{role:"user", content:"<tool_result …>"}`, the exact shape a text-matched marker keys on. Filter a hidden row at the RENDER choke point only — `hydrateSessionIntoChat` builds the model transport's refs from the same list the UI shows, so filtering earlier silently disables the compaction slice. |
| **v14.39.0** | One compaction system — one summariser, three triggers, one durable marker; `session_search` to read behind it; drop-turns-first reordered to summarise-first; a turn envelope that stops growing; auxiliary sub-agent spend counted; the always-zero session message count fixed | An aggregate `sql` template that does not qualify its columns can self-compare and return 0 forever — here it fed `delete(chatSessions)`. Five absolute token constants each silently switched their own compaction step off on a small window: size every floor as a FRACTION of the budget it protects within. `"x".repeat(70_000)` scores ~300 tokens because BPE collapses a single-character run, so a "70K" fixture measures nothing — size fixtures in TOKENS and prove each test targets the band only its own step can act in. A guard that refuses on `updatedAt !== createdAt` will refuse forever once any bookkeeping write touches the row: binding a transport is not activity, and prune (destructive) and reuse (not) must not share a condition. |
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
