# Atlarix TODO

**Current version:** v14.45.0 — **published 2026-09-10** (tagged 2026-09-09; the tag run
stranded overnight, see below). The app is free; the Core lineup is
GLM 5.3 / Terra / Astra; the money path is honest in both directions (a cancelled turn is priced
from what was generated, a dropped connection retries); the skills marketplace is gone and skills
are files in `.atlarix/skills/`; project rules moved to `.atlarix/rules/`; and two prompt-injection
paths are closed — a repo can no longer replace Atlarix's operating instructions, and writes under
`.atlarix/` ask. Narrative in `docs/CHANGELOG.md`.

**This header has been wrong before.** It read v14.42.0 while `package.json` said 14.43.0 and two
versions had shipped, then "v14.44 SHIPPED" while nothing was tagged. Update it in the same commit
as the version bump, or do not trust it.

## 🚚 UNRELEASED ON `dev` — everything below ships at the next tag

All four repos are clean and pushed as of 2026-09-10. `dev` is ahead of the v14.45.0 tag by
the following, none of which a user has yet:

- **`e8ce619d` — `build-msix` `needs: [quality, build-linux]`.** It had `[quality]` alone, so
  it raced the job that uploads the `landlock-helper` artifact it downloads: msix pulled at
  20:55:35, the artifact appeared at 20:57:05, and because that download is
  `continue-on-error` the miss surfaced two minutes later as `verify-ci-package-out`
  reporting a missing `atlarix-sandbox-linux` — which reads like a packaging bug.
  `build-msix` gates `publish-release`, so v14.45.0 stranded as an invisible draft until the
  jobs were re-run. `build-windows` already had that dependency; msix was the outlier.
  **Only affects tag runs, so still unexercised.**
- **`419c8433` — the Windows runners are un-pinned** to `windows-latest`. See the entry under
  "Blocked on the owner" for what was proven and the one part that was not.
- **`f7d2e53b` — `formatCents` groups thousands**, and `PRO_SUMMARY` now matches the
  website's word for word (it claimed to and did not).

**ALREADY LIVE, not waiting for a tag** — these are server-side and took effect immediately:

- **`MARKUP` 1.4 → 1.8 in `atlarix-proxy` (`c0b1ef7`, Railway deploy `state=success`
  10:49Z 2026-09-10).** Core now costs a user ~29% more credit per call than it did
  yesterday, and **nobody was told.** 19 accounts have ever used Core; if one asks why a
  turn got dearer, this is why. Verified by deployment SHA, not `/health` — that endpoint
  returns `{"ok":true}` and proves nothing about which code is running.
- The launchpad: the login fix (`08b4f9d`) and the derived Core lineup (`aa607b6`) are
  deployed via Vercel.
- `atlarix-releases`: `docs/HEADLESS.md` split out of the README, the catalogue-count
  generator, and the `check-site-lineup` CI job (`bf4ff1f`, `e1ed363`). Then the README
  itself, 2026-09-10 (`fe6d36f`): it now leads with the site's own positioning line, and
  Core models / updates.json / research / contributing each moved to their own file. The
  hand-typed routing table in `docs/CORE-CUTOVER.md` had drifted to `openai/gpt-5.6-sol`
  and is now GENERATED from `core-models.json` by the same script as the lineup table.
  The GitHub About panel and topics were the real gap — they still carried
  `code-scaffolding` and said nothing about privacy.

## 📮 The v14.45 announcement went out — 115 recipients, 0 failures

`scripts/send-free-gpt6-email.mjs`, sent 2026-09-10. Log
`scripts/.outreach-free-gpt6-2026-09.log.json` (116 entries — 115 recipients plus one probe
to the owner). Re-running is safe: anyone logged `sent` is skipped, so a re-run targets
nobody without `--force`.

**Replies land at `amariah@atlarix.dev`** and the email invites them ("Real email, replies
come to me"). The next session should expect that inbox to have traffic, and two claims in
it are promises: **the browser extension** ("still in development; I'll tell you when it
lands") and the cross-tool pickup paragraph, which IS accurate — `AGENTS.md` §"Other tools'
configuration" tells the agent to ask before following another tool's rules file and to
offer to write the answer into `.atlarix/rules/`.

## 🧾 Owner actions, not code (both verified safe 2026-09-10)

- **Delete the "Atlarix Reviewer" LemonSqueezy product** (`1317705`, variant `2060123`).
  **Zero subscriptions ever** — checked against the live LS API, not inferred. No code
  references the variant, and `handle-lemon-webhook` handles only `pro`, so had anyone been
  subscribed they would already have been paying for an allowance they never received.
- **Archive, do not delete, `AmariahAK/atlarix-skills`.** It is the community skill registry
  that v14.45 removed, nothing in any repo references it any more, and it is PUBLIC with 2
  stars and no outside contributors. Archiving keeps the URL alive and read-only; deleting
  404s it. **`atlarix-mcps` is still live** and linked from the releases README — leave it.

**Self-test non-exit — a third data point (2026-09-05).** The packaged self-test on
macOS arm64 shows the same "all probes passed, process tree had to be killed" as the
Windows runs. Two consecutive runs of the SAME build differed only in outcome: one
FAILED → exited 1 on its own; one PASSED → did not exit. **It happens on the PASSING
path**, and nothing was left running afterwards. Next step is the grandchild
experiment recorded in `scripts/run-packaged-self-test.mjs`'s `DEADLINE_MS` docblock,
now runnable on macOS where a debugger is available.

## 🔤 Language option — IN PROGRESS

Thirteen locales ship (v14.43). The one trap from that work, because it recurs: **every
`t()` in the app was returning its own key** — a translation layer that resolves to the
key is indistinguishable from an untranslated app until someone reads the screen in
another language. Assert on a RESOLVED string, never on `t()` returning truthy.

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
  unified compaction into one compactor with three triggers and left the _announcing_ hand-rolled
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
A feature reachable only from a discouraged path is rarely seen and still wired. _Rarely exercised is
not the same as unreachable_ — this is the same reachability-not-presence rule the Dyad-era removal
ran on.

## 🧩 NEXT SESSION — the browser extension (owner, 2026-09-12: extension FIRST, CLOSED source)

**Phases 0 and part of 1 are on `dev`.** What is DONE, so nobody redoes it:

- **Shared page scripts extracted** — `src/lib/browser/page-scripts/` holds the walker,
  the `data-atlarix-ref` registry, the find ranker and the fill-target walk as pure
  strings with **zero imports**. Verified byte-identical to the originals before
  rewiring; `a11y-snapshot.ts` is now transport + formatters only.
  `page-scripts-portable.test.ts` pins the zero-import rule as a SOURCE-TEXT check — a
  type-level one passes on `import type` while missing the `import log from
"electron-log"` someone adds for a debug line.
  **CORRECTION 2026-09-12: "so a content script can run the identical bytes" is FALSE,
  and it was written into five places.** MV3 cannot execute a code string at all:
  `chrome.scripting.executeScript()` takes `func` or `files` and has no `code` property,
  the extension CSP forbids `unsafe-eval`, and in `world:"MAIN"` an `eval()` runs under
  the PAGE's CSP — which GitHub, Google and most banks block. The extraction itself was
  right and nothing is wasted; only the transport assumption was wrong. The fix is to
  reshape the module from string builders into a function whose `.toString()` serves
  both backends — the desktop keeps composing a string from it (so `browser.ts` and
  `a11y-snapshot.ts` take ZERO diff), and the extension passes the function to
  `executeScript` with JSON-serializable `args`. `src/types/chrome.d.ts:130-136` already
  declared that shape correctly, so the typings were right and the prose was not.
  **A second rule follows and is new: zero MODULE-SCOPE REFERENCES.** A stringified
  function cannot close over its module, and this did not matter while the scripts were
  literal strings.
- **`packages/extension/`** — own tsconfig (`types: []`, no Node/Electron), own vitest
  project, wired into `npm run ts`. **No new dependencies**: the Chrome API surface is
  declared by hand in `src/types/chrome.d.ts`, which doubles as the Web Store
  justification list.
- **`shared/browser-api.ts`** — namespace resolution + capability probe.
- **`permissions/always-ask.ts`** and **`permissions/site-grants.ts`** — 44 tests.

- **The manifest and the build — DONE 2026-09-12.** `packages/extension/manifest.json`
  (MV3, no `key` yet — see below), `scripts/build-extension.mjs` on esbuild, and
  `packages/extension/package.json`. `npm run build:extension` writes
  `dist/unpacked/` to load and a **reproducible** `dist/atlarix-extension-<v>.zip` to
  upload (sorted entries, fixed 1980 timestamp, so "did it change" is a checksum). The
  zip is hand-rolled with `node:zlib` because CI runs `windows-latest`, which has no
  `zip` on PATH. Four guards, each verified by making it fire: a Node-builtin resolve
  plugin, a manifest/package version-mismatch check, a PNG IHDR dimension assert on every
  icon, and a fatal on missing Supabase env rather than `?? ""`. **`esbuild` is now an
  explicit root devDependency** — two scripts imported it on a transitive vite hoist. Its
  `knip.json` `ignoreDependencies` entry must STAY: knip's `project` is `src/**` with no
  `scripts/**` entry, so it cannot see either import, and the entry now suppresses
  "unused devDependency" instead of "unlisted dependency". **`npm run ts:extension` is
  now in CI** — `check:ts` is `tsconfig.app.json` (`include: ["src","shared"]`), so this
  package had NO type check in CI at all, and the extension vitest project cannot
  substitute because jsdom-under-vitest keeps Node's globals. `check:lint` widened to
  `oxlint src packages` for the same reason.

**What is DONE, newest first:**

- **The kernel refactor — DONE 2026-09-12.** `atlarixPageKernel` is one exported
  function in `page-scripts/index.ts` (NOT a sibling file — keeping it in the same module
  is what lets the zero-import rule stay literally true instead of needing an exception).
  `snapshotScript`/`findScript` compose `(${KERNEL_SRC})(${jsonArg(req)})`;
  `WALKER_PREAMBLE` is gone. **`browser.ts` and `a11y-snapshot.ts` took ZERO diff** —
  only the producers changed — and `page-scripts-refs.test.tsx` plus
  `renderer/browser-fill-target.test.tsx` pass UNEDITED, which was the gate. Reads only;
  `resolveElementJs` and `RESOLVE_FILLABLE_JS` share none of the walker helpers and stay
  strings until Phase 3. Caps now travel as `req.max` instead of being spliced in as
  `const MAX = 200;`.
  **The new rule is zero MODULE-SCOPE references, guarded three ways**: a source-text
  check that derives the module's own bindings, a runtime test that evaluates the kernel
  in global scope, and `page-scripts-bundled.test.ts` which runs BOTH real bundlers —
  esbuild (the extension) and Vite/Rolldown minified (the desktop, and a second
  independent chance to break `.toString()`, since a minifier may hoist a repeated
  literal to module scope). One case turns `keepNames` on and asserts it BREAKS, so the
  build settings are pinned by evidence rather than by comment.
  **Trap for whoever writes the next test here: jsdom does not implement `innerText`.**
  `accName` reads it third, so a snapshot `name` in jsdom must come from `aria-label` or
  `title`; a fixture using plain child text yields `name: ""` and looks like a ranking
  bug that does not exist in a real browser. `find` is unaffected — it falls back to
  `ownText`, which uses `textContent`. Also: **esbuild cannot run under jsdom** (it
  asserts `new TextEncoder().encode("") instanceof Uint8Array`, and jsdom supplies those
  from different realms), which is why the bundler checks live in the `node` project and
  the DOM behaviour in the `renderer` one.

- **PKCE auth — DONE 2026-09-12.** `pkce.ts` (WebCrypto only, pinned against RFC 7636
  Appendix B's published vector), `session.ts` (over `storage.local`, treating it as
  untrusted input), `gotrue.ts` (three calls, `fetch` injectable), `sign-in.ts`.
  **Verified against the live project**: signed in as a real user in Brave, session
  persisted across a panel reopen, and the pinned redirect matched with no silent Site
  URL fallback. Both Google AND GitHub are enabled on the project — checked, each 302s
  to its real endpoint, rather than assumed.
  Three things are load-bearing and each is pinned: the verifier NEVER touches storage
  (making TODO:1490's launchpad bug impossible rather than defended against); `signIn`
  runs in the side panel because a consent screen outlives the ~30s worker; and
  `getAccessToken` is SINGLE-FLIGHT because Supabase rotates refresh tokens and the
  loser of a race gets `400 invalid_grant`, which presents as a spontaneous logout.
- **The page-script transport — DONE 2026-09-12.** `page/inject.ts`:
  `executeScript({func, args, world:"MAIN"})`, `allFrames` false, each pinned by test
  because each fails SILENTLY. Plus `permissions/host-access.ts`, which makes a site
  grant real: `permissions.request()` → true → `grantSite()`, **in that order**, since
  `request()` resolves FALSE on decline rather than rejecting. `canActOn` requires both
  halves to agree, because a user can revoke from chrome://extensions without telling us.
  Manifest gained `tabs` + `scripting` with their first callers.

- **`chrome.debugger` input + the tab-group manager — DONE 2026-09-13.**
  `tabs/group.ts` is one group per WINDOW (a group cannot span windows), emerald, and a
  stored group id is NEVER trusted on its own — every read goes through `tabGroups.get`,
  because the id outlives the group and `tabs.group({groupId})` with a dead id lands a tab
  in whatever group has since taken that number. Closing the group is the stop gesture.
  `page/trusted-input.ts` attaches ONLY to tabs in that group, verified against the
  browser: attaching shows a banner and EVICTS DevTools, so a bad tab id would otherwise
  banner the user's bank tab. Detach is a NORMAL path — the banner has a Cancel button —
  and a mid-flight "detached" drops the record so the next call re-attaches rather than
  failing identically forever. `windowsVirtualKeyCode` is set on every key: without it the
  event arrives `keyCode: 0` and every framework's "was that Enter?" reads no, which is
  the same silent-nothing the module exists to prevent. `typeText` sends per-character
  events rather than `Input.insertText`, which produces NO key events, so an autocomplete
  that opens on keydown never opens.

**PHASE 1 IS COMPLETE.** Next is Phase 2 (loop, sessions, memory, skills), then Phase 3
(desktop bridge + `target` param), then Phase 4 (Supabase, launchpad, docs, store).

### CAN ATLARIX DRIVE THE BROWSER YET? NO — and the gap is precise (checked 2026-09-13)

Asked directly, and worth answering by grep rather than from memory, because the parts
that exist look like more than they are.

**What works today:** the EXTENSION can read a page, in a tab whose origin the user
granted, triggered by a button in its own side panel. A ref survives between two separate
`executeScript` calls. That is all, and it is by hand.

**What does not exist, verified:**

|                               |                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop → extension transport | **NONE.** No native-messaging host, no `externally_connectable`, no `nativeMessaging` permission. The only `runtime.sendMessage` in the package is a comment. |
| `target: "app" \| "chrome"`   | **NONE.** `src/lib/tools/browser.ts` contains zero `target` references — the seam is still unbuilt, over ~40 direct `view.webContents.*` sites.               |
| Kernel action ops             | **READS ONLY.** `PageRequest` is `snapshot \| find`. `click`/`fill`/`key`/`hover`/`scroll` remain desktop-only strings until Phase 3.                         |
| `page/trusted-input.ts`       | Built and tested; **called by nothing** but its own test. It is waiting for a loop.                                                                           |
| `tabs/group.ts`               | Used only by `trusted-input.ts`. No tab is ever adopted yet.                                                                                                  |

So the honest summary: **the extension can drive Chrome; Atlarix cannot drive the
extension.** Phase 2 makes the extension drive itself (its own loop, its own chat), which
needs no bridge. Phase 3 is what lets the desktop reach it, and it needs all four rows
above.

**Do the `X-Atlarix-Surface` ledger label FIRST** — before any Core dispatch, per the
shared-wallet section. A ledger row cannot be re-attributed later. **DONE 2026-09-13, see
below.**

### The ledger label — DONE and DEPLOYED 2026-09-13

`X-Atlarix-Surface` ships end to end. Migration `20260913120000` is APPLIED (the
only pending one; verified with `supabase migration list` first), the proxy is
deployed on Railway at `8d574f78` — **verified by deployment SHA, not `/health`**
— and the launchpad has the labels.

**Verified after applying, because the CLI saying "up to date" proves nothing:**
`proacl` reads `authenticated=X/postgres` on `debit_wallet` and `service_role`
only on `debit_wallet_service`, with **no PUBLIC entry on either** — the
`CREATE OR REPLACE` re-grant trap did not bite. Only ONE `debit_wallet` exists
(3-arg), so the overload ambiguity was avoided. The CHECK now reads
`('app','reviewer','cli','extension')` and `credit_transactions_kind_check` is
untouched, which confirms the dynamic constraint lookup found the right one.

**Order matters if this is ever redone: migration BEFORE the proxy.** `debitWallet`
is best-effort and swallows RPC errors, so a proxy deployed first would not fail
loudly — it would serve turns and silently lose every debit.

`accName` was fixed in the same session (see below), so the extension and the
in-app browser both name icon-only controls now.

### accName — FIXED 2026-09-13

Icon-only links read as a bare `[e1] a`. Now reads `aria-labelledby` (resolved
and joined), then `alt` on the element and on a contained `img[alt]`, then an
input's `value`. **HN's own logo stays nameless** — it carries no `alt`, so
there is genuinely no name and inventing one would be a guess presented as fact.
The backtick rule caught a backtick in the new PROSE: `toString()` includes
comments.

## 🧪 Muse Spark 1.3 vs GLM 5.3 on core-1 — RESEARCH ONLY (owner, 2026-09-09)

Owner asked whether GLM 5.3 should stay now that Meta's **Muse Spark 1.3** exists. On paper
it wins on every measurable axis, by a little:

|            | GLM 5.3       | Muse Spark 1.3                 |
| ---------- | ------------- | ------------------------------ |
| in / out   | $1.40 / $4.40 | $1.25 / $4.25                  |
| cache read | $0.26         | $0.15                          |
| context    | 1.00M         | 1.05M                          |
| max output | 131,072       | 131,072                        |
| inputs     | **text only** | text, image, video, pdf, audio |

First-party provider exists — `https://api.meta.ai/v1`, `META_MODEL_API_KEY`,
OpenAI-compatible — and OpenRouter carries `meta/muse-spark-1.3` as a rollback target.
Adoption would be one line in `PROVIDER_KEY_ENV_NAMES`, a `providers.meta` block, and an
entry in `pick-core-model.mjs`.

**NOT A MANDATORY SWITCH — owner decision 2026-09-09.** Adopting Meta means a **finance
migration**, not just a config edit: another vendor to onboard, fund and reconcile, on a
card that has already failed one provider (see the Kimi round). So this stays open as
RESEARCH, revisited only if the benefit grows past that cost. Nothing here is owed; do not
treat it as a queued task, and do not swap core-1 on the strength of the table above.

**Why it was queued rather than done in the first place.** The price win is ~11% input / ~3%
output, which does not by itself justify a provider migration; the real prize is multimodal
on the BUDGET tier.
And core-1 is the tier **Atlarix Reviewer runs on** — 39c a review, 4 findings, zero false
positives on the live run. Swapping the proven reviewer model on reputation is the one move
here with real downside. Run `npm run eval` before deciding, and check Meta's billing
accepts a Kenyan card BEFORE any integration work — that is exactly what wasted the Kimi
round.

**DO NOT use the `-contributor` variants.** `muse-spark-1.3-contributor` is $0.10/$0.20 —
12x cheaper and very tempting — and its catalog name is "Data Used for Training". Routing
customer code through it contradicts "The Private AI Workstation" and the README's promise
that Core requests are not logged or retained.

## ✅ Core reliability + billing — all three CLOSED 2026-09-09

`002ba1bb` (app), `420e481` (proxy). The traps are in §Traps; what belongs here is the one
diagnostic habit the incident produced:

**Anchor on the STEP, not the turn.** The failing request was issued at `23:15:21.151` and
died at `23:15:21.425` — 274 ms. The `23:14:51` line that makes it look like 30 seconds is
the start of the USER'S TURN. The op id decoded to 23:15:17 and dated the tool
independently. The first pass diagnosed it as a timeout and was wrong.

## 🧾 `/v1/responses` — SHIPPED 2026-09-08

`be76d24` + `afccf1e` (proxy), `cc15d3b` (releases). The money path never learned a second
dialect — `usage.ts`, `cost.ts` and `server.ts` are untouched by those commits, verified by
diff. Rollback rehearsal done (owner-confirmed 2026-09-09).

**Rolling back LOSES reasoning entirely**, and that is not obvious from the config: tools
plus a non-`none` effort is a hard 400 on `/chat/completions`, so the proxy forces
`reasoning_effort: "none"`. A rollback is a capability downgrade, not a neutral revert.

## 🛡️ Launchpad Turnstile — DEFERRED, and now with the reason measured (owner, 2026-09-09)

**Captcha is ENABLED on the Supabase project** (Authentication → Attack Protection →
Turnstile), and the Cloudflare widget `atlarix-auth` exists (Managed mode, 2 hostnames).
Nothing renders it, so it has never been solved once — the Cloudflare dashboard reads
_Insufficient Data_ for that widget's "Likely human" column.

**DECISION 2026-09-09: do NOT render it yet.** The earlier framing — "the wiring is the
expensive half, land it now" — does not survive contact with the deployed CSP.

**Rendering it requires widening THREE directives of an enforcing CSP**, not the two you
would guess. `atlarix-launchpad/vercel.json` carries a real `Content-Security-Policy` (it was
flipped from Report-Only in `80218a3`), and Turnstile needs:

1. `script-src 'self' 'unsafe-inline'` → must admit `https://challenges.cloudflare.com`
2. **`frame-src 'none'` → must admit it too.** The challenge is an iframe. Hardest blocker,
   and the one nobody remembers.
3. `connect-src` is set explicitly, so `default-src` does not cover Turnstile's XHR either.

**And it would gate nothing.** A repo-wide search for every captcha-protected Supabase
endpoint (`signUp`, `signInWithPassword`, `signInWithOtp`, `resetPasswordForEmail`, `resend`,
`verifyOtp`) finds **exactly one auth call in the whole project** — `useAuth.ts:76`
`signInWithOAuth`, a redirect-builder with no `captchaToken` path — plus
`CheckoutButton.tsx:49` `getSession()`. There is also **no backend to verify a token with**:
no `api/` directory, no middleware, and `supabase/` holds only `config.toml`.

So the trade is: weaken a policy you just moved to enforcing, for analytics signal, on a page
with no captcha-enforcing endpoint. **Land the render together with the first non-OAuth
path**, when the token has somewhere to go. Until then the abuse lever that actually applies
is Supabase's **Auth → Rate Limits**.

**Owed instead (small, and unrelated to captcha):** `Login.tsx:27-36`'s comment still asserts
"the CSP is still `Content-Security-Policy-Report-Only`, so it reports and does not enforce".
**That has been false since `80218a3`.** A comment describing the opposite of the deployed
policy is worse than no comment — fix it while touching that file for the stopped-login bug.

**Two facts that decide how far this goes, so nobody implements half of it and calls it
protection:**

- **Supabase enforces captcha only on the endpoints supabase-js calls DIRECTLY** — signup,
  password grant, OTP, recover, resend, verify. Atlarix uses **none** of them: both the
  launchpad (`src/hooks/useAuth.ts:76`) and the desktop app
  (`src/lib/auth/supabase-client.ts:186`) are OAuth-only (`signInWithOAuth`), and the OAuth
  authorize/callback pair is not in that set. So **a rendered widget gates nothing today** —
  it collects Cloudflare-side signal and lights up the analytics, and that is the whole
  benefit until a non-OAuth path exists.
- **The moment an email/password or magic-link path is added, the widget becomes mandatory**,
  and the token has to be threaded through as `options.captchaToken` or that path fails with
  `captcha_verification_failed`. That is the real reason to land the render now: the wiring is
  the expensive half, and doing it cold under a broken login is how this becomes a bad hour.

**Not a substitute for:** the missing `headers` block in `vercel.json` (no CSP/HSTS/
frame-ancestors on `/login` and `/account`, while `Login.tsx:27` asserts a "strict CSP" that
does not exist). For an OAuth-only signup path the abuse lever that actually applies is
Supabase's own **Auth → Rate Limits**, not captcha.

## ✅ v14.44 — released; the decisions that outlive it

Narrative in `docs/CHANGELOG.md`. Kept here only because each of these reads like an
oversight and is not:

- **Resource caps are CORRECT: MCP 10, automations 10.** Resource limits, not plan limits;
  no tier raises them. **Do not touch the numbers.** MCP's 10 counts _enabled_ servers
  (v14.45). The skills cap was RETIRED with the marketplace — its only enforcement site was
  `skills:install`, and repo skills were never capped.
- **Account registration is REQUIRED and stays** (`SimpleChatInput.tsx`, `mustSignIn`).
  BYOK and local Ollama are free of metering but not usable anonymously. Deliberate.
- **Astra is NOT capped.** `maxOutputTokens` sizes the reasoning budget, so capping the
  tier whose value IS reasoning is the worst place to economise.
- **`DelegationConfigSchema`: only `tokenBudgetPerTurn` is read.** A fourth field was
  wired-looking and dead. Do not attach behaviour to the remaining three without following
  one to a caller that supplies it.
- **The money path is honest in both directions** — a cancelled turn is priced from what
  was generated, and a dropped connection retries. A cancelled _reasoning_ turn
  under-charges deliberately, because reasoning tokens reach us only as a shorter summary.
  Do not "restore" the reserve.

## 🧠 Why a GPT tier shows no thoughts mid-turn — MEASURED, nothing to fix

Reads exactly like a broken feature and costs a full pipeline audit to answer, so:

**OpenAI emits NO reasoning summary on a step that CALLS A TOOL.** Measured on both Astra
and Terra with our own key: 87/81 summary events on an answering step, **0 on a tool-calling
step**. `effort: "high"` + `summary: "detailed"` changes nothing. There is no lever.

**And the more common cause: the model often does not reason at all.** Reasoning effort is a
CEILING, not a floor — `hey how are you?` burns 0 reasoning tokens even at `effort: "high"`,
so there is nothing to summarise. **Read `reasoning_tokens` before suspecting the pipeline.**

In a coding harness most steps are tool calls, so thoughts land on the step where the model
stops calling tools and writes its answer. A turn still mid-fan-out showing only tool cards
is correct. **The pipeline was verified end-to-end while chasing this — do NOT re-audit it.**

## 📦 v14.45 — the marketplace is gone; what is left is smaller and safer

Shipped 2026-09-09. Narrative in `docs/CHANGELOG.md`; the code carries the reasoning in
comments. What stays here is what a future reader would otherwise undo.

**Decisions, not to be reversed:**

- **No skills marketplace, and no registry to install from.** Users research a skill when
  they need one or ask the model to write it. The generalisation is the useful part: a
  skill is inert text, an MCP server is a live connection holding credentials with remote
  side effects — curation belongs where a mistake has consequences.
- **No `find_skill` tool.** One was written and deleted the same day. `grep` and `glob`
  already read `.atlarix/skills/`; a dedicated search tool is a second way to do a thing
  that works. **Do not re-propose it.**
- **Workspace skills are a COUNT in the prompt, never a catalogue** — flat cost whatever
  the repo holds. Bundled guides keep their per-entry lines, because grep cannot reach
  inside the app bundle and a count would make them unreachable rather than unlisted.
- **The prompt says nothing when there is nothing.** Announcing that skills and MCP servers
  do not exist cost ~40 tokens a turn to duplicate what `list_available_mcps` answers on
  demand.
- **`.atlarix/atlarix.md` stays in the ladder below `.atlarix/rules/`** — every existing
  user has one, and removing the rung would delete their instructions silently.
- **The config importer was dropped and should stay dropped.** Per-vendor parsers for three
  `mcp.json` shapes go stale the week they are written and know nothing about the next
  tool. The model reads any config and proposes it through `manage_mcp_server`; the base
  prompt names no vendor, which is what makes it universal.
- **MCP cap counts ENABLED servers.** Storing is free, connecting is not. At the ceiling
  Atlarix refuses and names what to disable — never auto-evicts, which would rewrite a
  user's configuration silently.
- **`mcpServers.enabled` defaults to FALSE.** A comment briefly claimed the opposite; the
  default is the safe one, so an inserter that forgets lands a server inactive. Do not
  "fix" it.

**Still owed from this release:**

- [x] `atlarix-releases` README pushed with the tag — the `.atlarix/skills/` description
      became true at v14.45.0, and the repo's docs were restructured on top of it
      (`fe6d36f`).

## 🩹 Edit results were lost when "Approve rest of turn" evicted the op — FIXED 2026-09-11

A real write reported **"Successfully wrote README.md, added: 0, removed: 0"**, so the model
disbelieved its own edit and spent a turn on `git diff`. Confirmed from
`~/Library/Logs/Atlarix/main.log`, not inferred: `[approveRestOfTurn]` →
`[executeAllOperations] Processing 1` → `Wrote file: …/README.md` → `Completed all 1
operations` → `[Build Mode] Permission approved: op_1789120127239_9w4wgisfg`.

`executeAllOperations` deletes every operation it ran from `pendingOperations`. The build
branch then calls `getExecutionResult(operationId)`, which found nothing and returned
`{success:false, error:"Operation … not found"}` — and its caller had already decided the
write succeeded, so it announced success while the counts, computed from `oldContent ?? ""`
against `newContent ?? ""`, came out 0/0. **Single-approve never evicts, which is why this
read as intermittent.**

Three quieter losses in the same payload: `path` went undefined, the fuzzy-match notice
never reached the model, and **`verified` was lost** — and since `undefined` is falsy, an
unverified write ran `clearUnverifiedEdit` instead of `recordUnverifiedEdit`. The
self-review gate was silently forgiving exactly the writes it exists to catch.

Fixed by `PermissionInterceptor.fileOpResults` — the same shape `commandOutputs` already
had for commands ("survives pendingOperations eviction"); writes never got it. Plus two
rules: a result reporting failure is no longer narrated as success, and a genuine 0/0 diff
now carries a note saying the content already matched, so the ambiguity that sent the model
to `git diff` is gone. Pinned by `exec-result-survives-eviction.test.ts` — 3 of its 4 cases
fail with the fix disabled (verified by disabling it, not assumed).

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
2. **The extension never gets a filesystem or a shell.** That is not a missing feature, it
   is the containment: the extension is the user logged into their bank and their email,
   and the absence of local execution is what bounds a prompt-injection blast radius.
   Artifacts (charts, PDF, CSV) are rendered in the offscreen document and handed over via
   `chrome.downloads` — never written to a disk the agent can reach.
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

## 🔜 Next session — the queue

Rewritten 2026-09-10. The 2026-09-09 handoff list is fully discharged: v14.45 is
released, the launchpad login fix shipped (`08b4f9d`), and **telemetry + Harbor are
DONE per the owner** — both sections deleted rather than ticked.

1. **Browser extension** — NEXT. Phase 0 and the permission model are committed on
   `dev`; resume at Phase 1's manifest, `chrome.identity` PKCE auth, the content-script
   transport, `chrome.debugger` input and the tab-group manager. **Closed source, and it
   stays in `Atlarix/packages/extension`** — see the decision record in its section.
2. **The CLI** — queued after it. TUI + loopback-PKCE auth + billing over the headless
   binary that already ships; the full brief is written and does not expire.
3. **CI must resolve the win32 + linux TypeScript 7 platform binaries.** Only
   darwin-arm64 is proven. The last open verification item.

**Carrying one residual from the Windows un-pin:** `electron-forge make`
(Squirrel.Windows) has never run on `windows-2025-vs2026`. The un-pin proved
`package`, not `make`, and `build-windows` gates `publish-release` — if the next tag
fails there, re-run the job and revert one line to `windows-2022`.

### ~~The reviewer's repository picker is empty for every existing install~~ DONE 2026-09-10

Fixed in `atlarix-reviewer` `d04b89d`. `github_installs.repositories` is written only from
webhooks, and for a `selected` install the only event that rewrites it is the user changing
their selection — so an install predating the column showed "selected repositories" with no
names, indefinitely. Not a rendering bug; nothing was ever stored.

`src/github/installation-repos.ts` fetches `GET /installation/repositories` using the
installation-wide token `app-auth.ts` already mints, and
`scripts/backfill-install-repos.ts` applies it through the SAME `applyInstallRepos(…, 'set',
…)` write path the webhook uses. Applied to `AmariahAK` (156439785) →
`["AmariahAK/atlarix-releases"]`, verified in the live table; re-running is a no-op.

**Deliberate, so nobody "improves" it:** `all` installs are skipped rather than enumerated —
that set changes as an account gains repositories with no webhook to announce it, and the
account page already renders `all` from `repository_selection` alone, which cannot go stale.
And the fetch THROWS on a non-2xx rather than returning a partial list, because the write is
mode `set`: a half-answer would turn a transient 502 on page two into permanent data loss.

It is a script rather than a webhook hook because it was measured first — 2 live installs,
one `all` and one `selected` — so it is a one-time migration of a single row. A network call
on every webhook forever to fix two rows is the wrong trade.

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

## ✅ Verification owed — one left

The packaged-app batch was walked and confirmed 2026-09-09; those items are gone rather than
ticked, because a list of things that turned out fine is not worth carrying.

- [ ] **CI must resolve the win32 + linux TypeScript 7 platform binaries.** Only darwin-arm64 is
      proven.

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
  guard _was_ the bug), so the fix is one call plus making `handleAuthResolved` clear `user`/`status`
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
  file at <https://support.github.com/contact> → _What can we help with?_ → **Marketplace** →
  _"App review pending for X weeks, no updates received"_, including the app name, App ID, the
  GitHub org/account used to submit, and the SUBMISSION date (which may differ from the date the
  App went public).
- ~~**`build-msix` must `needs: build-linux`.**~~ **FIXED 2026-09-10 (`e8ce619d`).** It bit
  again on v14.45.0 exactly as this entry predicted — msix downloaded `landlock-helper` at
  20:55:35, build-linux created it at 20:57:05 — and because `build-msix` gates
  `publish-release`, the whole release stranded as an invisible draft until the failed jobs
  were re-run. Now `needs: [quality, build-linux]`, matching what `build-windows` already
  declared. **Unexercised until the next tag**, since it only affects tag runs.
- ~~**Un-pin the Windows runners from `windows-2022`.**~~ **DONE 2026-09-10.** MSIX run
  `34461113885` went green END TO END on `windows-latest` (= windows-2025-vs2026),
  `Build MSIX` included. `check-vs-toolchain` reported `versionYear 2026 · toolset v145`,
  and that script exits 1 without either, so a green step is the assertion. `toolset v145`
  is what vindicates the patch scanning `PlatformToolsets` rather than mapping from the
  MSVC version — VS 2022 17.14 ships MSVC 14.44 and is still `v143`. The image's VS
  _version_ differed between two runs hours apart (`18.9.12112.369` vs `18.9.12120.119`),
  which is the same argument against pinning anything version-derived.

  `msix.yml`'s two input defaults, its `runs-on` fallback, and `release.yml`'s
  `build-windows` are now `windows-latest`. `windows-2022` is kept as a dispatch OPTION —
  the way to A/B a Windows failure against the old image before blaming the runner.

  **The residual, stated because this is the part that was not tested:** that run proved the
  `msix` job, whose steps end at `electron-forge package`. `build-windows` additionally runs
  `electron-forge make` (Squirrel.Windows), which has never run on the 2025 image. The
  shared risk — npm ci, electron-rebuild, node-gyp, VS discovery — is proven; the maker is
  not. It gates `publish-release`, so if the next tag fails there: re-run the job, and
  revert one line to `windows-2022` before assuming the maker is broken.

  Also fixed en route: a manual `msix.yml` dispatch used to die at `verify-ci-package-out`
  on a missing `atlarix-sandbox-linux` — absent by design, since the helper download is
  gated to non-dispatch runs. `ALLOW_UNSANDBOXED_RELEASE` is now set for
  `workflow_dispatch` only, so manual runs reach `Build MSIX` while releases keep the
  strict check.

- **Windows code-signing cert** — native-sandbox CI, and the only real fix for the C6 residual on
  direct-download Windows. Release infra, no cert. The helper sign step is wired; set the secret.
- OAuth `state` nonce / PKCE stays **not doing** — attempted v14.12.0, broke sign-in, reverted. The
  flow-in-progress gate stays. Revisiting needs confirmation that the Supabase redirect-URL
  allowlist permits a query param.

## 🔐 Security — reviewer, money path and app hygiene ALL CLOSED (2026-08-30)

**One document remains, deliberately OUTSIDE every repository** (these repos flip public for
CI): `../SECURITY_SECRETS_2026-08-28.md`, the leak-response note.

Both audit write-ups were re-checked against the code and DELETED — a repo whose visibility
toggles is not a home for exploit write-ups. The lessons that outlived them are in §Traps.

## 📚 Docs drift — the check that catches it

Closed 2026-08-28. The lesson, which is the reusable part: the site said Pro was
pay-as-you-go while the account page said Pro included Core, and **both shipped**. The fix
that stops the next one is not proofreading — it is embedding the single source verbatim
(the Core guide now embeds `CORE_EXPLAINER` from `products.ts`) so a fourth copy cannot
quietly appear.

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
extra replicas make it _less effective, never incorrect_ — holds up. `spend_from_wallet` takes
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

**What would change the picture:** any of these becoming real needs a _measurement_ first — the
Supabase request count is the tell, and the 2026-08-26 lesson was that 704 requests/hour looked like
the website and was actually a 5-second poll. Do not scale on a hunch.

## ☁️ Cloudflare — DNS migrated, DMARC enforcing; nothing owed

**Deliberately not doing, and each has a reason worth keeping:**

- **Grey-clouded, not proxied.** Vercel advises against a proxy in front of it — it
  intercepts their ACME path and breaks cert renewal, and every free-tier WAF / rate-limit /
  Bot-Fight feature is proxy-gated, so grey-clouding forgoes nothing we could have used.
- **Never proxy the Railway origin** (`api.atlarix.dev`). Cloudflare in front of a streaming
  SSE endpoint can buffer or time out and break token streaming for every desktop user. If
  it is ever revisited, do it alone and make a real streaming turn the acceptance test —
  `/health` would pass either way.
- **Cloudflare "DMARC Management" stays OFF.** It is report rendering, not policy, and it is
  built on Email Routing — enabling that publishes Cloudflare MX on the apex, which would
  displace Google Workspace and break the very mailbox the reports arrive in. If rendering is
  ever wanted, add a second `rua` pointing at a third-party service: one address, no MX.
- **DMARC is `p=quarantine; fo=1`, live 2026-09-09**, validated against five real aggregate
  reports (6/6 pass). The one SPF failure was a forwarder covered by an aligned DKIM pass —
  which is why `adkim=r` / `aspf=r` relaxed alignment must not be tightened without cause.
- **Trial credit: GONE for everyone**, verified against the live service (`PGRST202`, not the
  migration ledger). Do not re-propose it, at $1 or $5 or gated on anything.

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

### Summing `delta_cents` is not a balance — an allowance is SET, not added

Asked to audit revenue, I summed `credit_transactions.delta_cents` and reported the owner's
account held **$2,000,000**. The app said $1,000,000.67 and the app was right.
`grant_monthly_credit_service` SETS the allowance, so the ledger records a grant as a delta
while `balance_cents` is computed as **allowance + purchased** — $1,000,000 + $0.67. The
ledger is an append-only record of EVENTS; `balance_cents` is the authority.

**How to apply:** read `credit_wallet.balance_cents`, or the RPCs, for a balance. Use
`credit_transactions` for history and for per-kind spend, never for a total. The one number
that IS a valid sum is `kind='debit'` — that is real metered inference (all of $22.03,
ever, across 19 accounts, as of 2026-09-10).

Related: the two $1M rows on `0d66d5eb…` are a deliberate permanent owner comp
(`ref=pro:comp:owner:permanent`), not corruption.

### A mark-up is not a margin, and "40%" meant neither

`MARKUP` multiplies COST. 1.4 charged $1.40 per $1.00 of inference — `0.40/1.40 = 28.6%`
gross, and ~22.8% net once LemonSqueezy took 7.5% of money-in. Every doc called it "+40%"
for months. It is 1.8 now, which nets ~40%. **The ceiling is BYOK**: free in the same app,
with a per-reply cost on screen, so the escape hatch is one dropdown away.

### `signInWithOAuth` never returns an error — it rejects

`_handleProviderSignIn` builds the URL, calls `location.assign`, and returns
`{ error: null }` unconditionally, with **no network request**. So an `if (err)` branch on it
is near-dead, and real failures arrive as rejections. Under PKCE, `_getUrlForProvider` writes
the code verifier to storage BEFORE redirecting, so blocked site data (Safari private
browsing, "block all cookies", quota) throws — which hung the launchpad's sign-in behind a
spinner with no message for that whole class of browser. Fixed 2026-09-10; the shape
generalises to any `{ error }` wrapper around a vendor SDK.

### A `workflow_dispatch` of a CALLED workflow has none of the caller's artifacts

`msix.yml` downloads `landlock-helper`, which only exists in a `release.yml` run. Its
download step is correctly gated to non-dispatch runs — but `verify-ci-package-out` still
required the resource, so **every manual dispatch died there regardless of what it was
testing**, one step before the thing under test. `ALLOW_UNSANDBOXED_RELEASE` is now set for
`workflow_dispatch` only. Before dispatching a called workflow, ask which artifacts the
caller was providing.

### A number stale in the UNDERSTATING direction never gets audited

"145+ providers and 4,400+ tool-capable models" sat in ten strings across seven files while
the bundled catalogue carried 213 and ~6,590. Nobody caught it because the claim never became
FALSE — it just stopped being impressive. Same shape as the TODO advertising a $10 allowance
after it became $19: both halves were defensible in isolation. Derive anything a config or a
third party decides; `scripts/gen-readme-catalog.mjs` and the launchpad's
`gen-core-lineup.mjs` are the two worked examples.

### Two classifiers, one object, opposite verdicts

`isNetworkStreamError` followed `cause` but never `error`. The AI SDK hands `onError` an
ENVELOPE — `{ error }`, not the error — so `String(envelope)` was `"[object Object]"`, the
message regex matched nothing, and the network branch inside `onError` had **never once
fired** for a request-phase failure. Meanwhile its sibling `isNoUsableModelOutputError`
unwraps `.error` and therefore claimed the same object confidently. A dead socket was
reported to the user as a model that would not answer.

Neither classifier was wrong about the errors it was written for. What was wrong was that two
functions inspecting the same value disagreed about its SHAPE, and nothing compared them.

- **When two predicates over one value disagree, suspect the shape before the logic.** The
  bug is rarely inside either function.
- **A classifier that unwraps must unwrap everything its callers can hand it.** Following
  `cause` and not `error` is not a partial fix; it is a fix that reads as complete.
- **The verdict a classifier never renders leaves no trace.** There was no log line, no
  Sentry event and no failed test, because the branch simply was not taken. Absence of
  evidence looked exactly like absence of the failure.

### An SDK can replace your error with its own

The same incident, one layer up. When a request dies before any step completes, the AI SDK
enqueues an `error` part, then its flush sees `recordedSteps.length === 0` and rejects the
result promises with a **synthetic `NoOutputGeneratedError`** — discarding the original
`APICallError` entirely, not even attached as a `cause`. So the only error a caller can catch
describes a symptom the SDK inferred, not the failure that happened.

- **Classify at the point where the real error still exists**, then carry the verdict forward.
  `onError` sees the truth; the catch block does not.
- **Ordering is the fix, not the addition.** The unwrap has to run BEFORE the branch that
  matches the substitute error. Placed after it, it is dead code that looks like a fix.
- **Retry machinery that is "already tested" can still be unreachable.** Both
  `network-retry-socket-faults.test.ts` and `retry-jitter.test.ts` passed throughout: they
  test the classifier and the delays, and nothing tested that anything ever calls them with
  a real transport failure.

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
neither. Same reasoning kept `installed_skills.scope`, which is part of a composite primary
key. **Narrow the TYPES, leave the columns.**

**Except that `installed_skills` itself goes in v14.45** — the whole table, via a NEW
migration, because the skills marketplace is being deleted and nothing else reads it. That
does not weaken the rule above: dropping a table nothing uses is not the same as changing a
column that live code binds. The old migrations (`0042`, `0049`) and their journal entries
stay exactly as they are — they are applied history keyed by hash, and rewriting them breaks
every existing install's ledger.

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
rather than defers. The trap is answering "add a CAPTCHA to login" without checking the auth _shape_
— and its mirror, which caught me here: having concluded that, do not then assume there is nothing
to protect. `claim_signup_credit()` is an RPC that pays out real money per account and _could_ carry
a token. Auth flow and money flow are different questions.

### A `sql` template does not qualify its columns — a subquery can silently self-compare

`sql\`select count(\*) from ${sessionMessages} where ${sessionMessages.sessionId} = ${chatSessions.id}\``renders BOTH sides unqualified:`where "session_id" = "id"`. Inside the subquery both names resolve
against `session_messages`, which has its own `id`, so every row compared its `session_id`to its own`id`and the count was **structurally always zero**. It returned a plausible number, never threw, and
drove a delete. Use a`leftJoin`+`groupBy` where the query builder qualifies for you; if a raw
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
  log, nothing a `try/catch` sees. Electron's "call it early" means early _within_ the ready phase.
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
  signature and AMFI validates the _authorisation_. Two different gates. Cost v14.35.0 two tags.
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
  the run **annotations**: _"The job was not started because an Actions budget is preventing further
  use."_ Workaround is flipping the repo private → public for the release window (Actions is free on
  public) — ask first, and remember clones made during the window persist.
- **A hung job writes NO log** — `build-linux` sat 79 minutes on `apt-get` (11s the release before).
  Watch the **step's** `started_at`, not the run's. `cancel` + `rerun --failed` is lossless:
  successful jobs keep their outputs and uploaded assets are untouched.
- **Duplicate asset uploads 422 _green_ while keeping the OLD asset** — delete the draft before
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

  ```sql
  -- did the body actually change?
  select position('<a token unique to the new body>' in pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '<fn>';
  -- and did the grants survive? (see the PUBLIC trap below)
  select array_to_string(p.proacl, ' | ') from pg_proc p … ;
  ```

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
is _what happens when the list is incomplete_; the reasoning is in git and `DESIGN_NOTES.md`.

- **`defaultWritablePaths`** (`lib/sandbox/wrap-command.ts`) — a _write_ allowlist; incomplete fails
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
  the shared _agent_ session is. Capture, don't build yet.

---

## 📦 Shipped — index

Version prose lives in [`CHANGELOG.md`](./CHANGELOG.md) (current window) and
[`CHANGELOG_PREVIOUS.md`](./CHANGELOG_PREVIOUS.md) (one line per older version).

**The version → trap table that used to sit here is gone.** It restated the traps that are
consolidated in §Traps above, in a second wording, in a table wide enough that nobody read
either — and two copies of a lesson is how one of them ends up contradicting the code. If
you want to know which release a trap came from, `git log -S` the phrase.
