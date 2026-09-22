# Atlarix Changelog

> Entries are condensed to the shipped changes per version. Full prose, rationale, and
> file-level detail live in the git history.

## [14.50.0] (2026-09-22) — Dictation goes where the audio can actually go, and the app stops holding what it cannot use

**On-device speech recognition is gone, and that is the headline fix.** Dictation ran
whisper-small (transformers.js + onnxruntime-web) inside the renderer, and it was warmed on a
`useEffect` whenever a composer MOUNTED — with `"local"` as the default engine, that meant every
session start. Sampled on an 8 GB Mac, one second apart:

```
idle   renderer   149 MB   cpu   0%
+1s    renderer 1,530 MB   cpu 508%
```

Thirteen seconds of multi-core saturation and ~285 MB of weights, whether or not the microphone
was ever touched. The app's own crash snapshot recorded `systemMemoryUsageMB: 7885 / 8192`. It
took the whole machine down twice.

The rest of this release is the same theme: the app was holding, re-sending and reserving things
it could not use.

### Added

- **The mic follows a capability, the way Deep thinking does.** It appears when there is somewhere
  to transcribe and hides when there is not — never appears and then fails. Two independent
  routes, either one enough: a **BYOK speech key** (billed to your key, never to Atlarix Core,
  works on every model including Anthropic, which declares audio on zero catalog models), or **the
  selected model itself** when it declares `audio` input, sent over the same client and routing a
  chat turn uses, needing no key at all.
- `audio` is a first-class modality in the models.dev catalog, so this needs no hardcoded list.
  The answer is resolved in MAIN and stamped on the model row — **through the Core tier→vendor
  map**, because a Core row's provider is the synthetic `compass` and its name is a tier id, and
  asking the registry about `(compass, core-1)` answers false for the entire lineup. That is the
  bug that hid Deep thinking for every Core model once already; a test now fails against the
  unresolved pair.
- **A window whose workspace was deleted elsewhere says so.** `delete-app` broadcast no event, so
  a second window kept rendering a workspace that no longer existed, with every action failing on
  a missing path. It now stops its streams and shows what happened.
- **Temp directories are swept** on quit, at startup, and on a timer. `atlarix-attachments` and
  the agent's scratch files were created and never removed — fine on macOS, mostly fine on Linux,
  and simply false on Windows, which never cleans `%TEMP%` unless Storage Sense is on. One
  startup measured 478 leftover directories.
- **Writes to the memory folder and the agent scratch directory no longer raise an approval card.**
  The prompt tells the agent to use exactly those two places, and the gate then asked about every
  write to them — the harness arguing with itself, at a card per note. Containment-checked, never
  substring.

### Changed

- **Command output streams deltas instead of the whole buffer.** Every `data` event used to ship
  the entire accumulated output to every consumer, unthrottled — measured at 38x amplification on
  a 5 MB build log, and 218 ms of blocked renderer main thread per command against 6 ms for the
  deltas. Deltas break on line boundaries, so an ANSI escape can no longer be split across a
  chunk and leak into the UI as text.
- **What the UI retains is now bounded by a constant, not by what your command prints.** A 50 MB
  build log used to mean 50 MB held in renderer state per command, for as long as the card lived.
  The full output is still intact in the tool result, the Terminal tab and `background_jobs`.
- **Read-only modes deny the source tree instead of dropping the workspace.** Explore, Plan and
  Review used to remove the workspace from the writable set entirely, which also broke every
  Vite-based project at startup, `npm install`, every build, every dev server and `git fetch` —
  all of which those modes' prompts claimed worked. The prompts no longer claim it, either.
- **Recording asks for ogg/opus first**, falling back to webm. Not cosmetic now that the clip is
  always uploaded: OpenAI's `/audio/transcriptions` takes both, but Gemini's inline audio part
  documents wav/mp3/aiff/aac/ogg/flac and **not** webm — which is what Chromium's MediaRecorder
  produces by default. The upload filename follows the container too, since OpenAI validates the
  extension independently of the content type.

### Removed

- **The on-device speech engine**: `whisper-worker.ts`, `whisper-config.ts`, the
  `@huggingface/transformers` dependency and its `patches/` entry, live transcription (it
  re-transcribed a growing buffer every 1.5s — viable only against a local WebGPU pipeline;
  against a metered API it would bill every 1.5s for the same audio), the `voiceInputMode`
  setting, the model-download progress UI, the "Clear cache" button and the `voice:log` channel.
  Weights cached by previous versions are deleted once at startup, because `userData` survives
  reinstalls and nothing else would ever remove them.
- **`'wasm-unsafe-eval'` from `script-src`.** The speech worker was the only thing in the renderer
  that compiled WASM — verified by grepping the built chunks for `WebAssembly.instantiate` rather
  than assumed. The `@huggingface/transformers` → `onnxruntime-node` → `adm-zip` → `sharp`
  advisory chain that had no fix available is also gone from `npm audit` entirely.
- **A hardcoded 4 GB V8 heap ceiling** that had shipped since v8.0.4 commented "Raise V8 old-space
  ceiling". It could not raise anything. Measured with a bare Electron probe on an 8 GB machine:

```
flag                        main       renderer
(none)                      4192 MB    3586 MB
--max-old-space-size=4096   4192 MB    3586 MB   ← asked to RAISE: no change
--max-old-space-size=256    4192 MB     368 MB   ← asked to LOWER: applied
```

  Main ignores it outright; the renderer honours it only downward, so past ~9 GB of RAM it would
  silently CAP the renderer. Chromium and V8 already size the heap from physical memory — about
  half the machine, on macOS, Windows and Linux alike — which is the adaptive behaviour a
  hardcoded number destroys.

### Internal

- Build and test tooling is sized to the machine rather than to a constant
  (`scripts/lib/machine-limits.mjs`). Packaging asked for an 8 GB heap and Vitest forked
  `ncpu - 1` workers with no regard for RAM; on an 8 GB laptop that reached 39.7 GB of swap and
  4% free memory. Now: heap = half the machine (floor 2 GB, ceiling 8 GB), workers = the lower of
  what the CPU and the memory allow. CI is unchanged — the CPU is still the binding limit there.
  Measured after: swap peaked at 494 MB, and the suite took the same wall-clock time, because the
  machine was memory-bound rather than CPU-bound.

**Tests:** 5,353 passing. Typecheck, lint, sandbox cross-target, i18n and edge-function checks
clean.

## [14.49.0] (2026-09-21) — The model has a name again, and the sidebar stops shouting

**Nothing in the composer ever told you which model you were on.** The only control was an
unlabelled sliders icon whose menu held the name as text you could not click. So people added
their own API key, watched their models appear in the picker, and went on spending Atlarix Core
credit with no cue that anything was still pointed at Core — the app had grown a persisted
one-time coachmark to announce a fact the interface could simply have shown. It shows it now:
the model's name is the button, it is there in every layout, and clicking it opens the picker.

The sidebar's other problem was a wrong token rather than a taste. `--accent` is `#f59e0b` in
both light and dark, and five places inside the sidebar were painting with it instead of
`--sidebar-accent` — which is why a selected workspace read as a warning banner, with its
timestamp sitting on top at roughly 1.6:1.

### Added

- **A model chip in the composer** (`src/components/ModelPicker.tsx`). Names the current model,
  opens the picker, and answers `Cmd/Ctrl+J`. Prices are shown per row, providers are grouped
  when you have not typed anything, and an empty list now says "no providers configured" and
  where to fix it rather than "type to search".
- **`Cmd/Ctrl+N` opens a new window** — a real File-menu accelerator (`src/main.ts`), so it works
  with the caret anywhere, and it is listed in the shortcuts sheet.
- **`Cmd/Ctrl+K` works everywhere.** The workspace-search palette is mounted at the app root
  (`src/components/GlobalAppSearch.tsx`) instead of inside a sidebar panel that only renders on
  some routes. The shortcut table carried it as `hidden` for exactly that reason; it is
  advertised now.

### Changed

- **The sidebar's workspace row is a header, not a tree row** (`src/components/AppList.tsx`). The
  disclosure chevron could only hide the panel's one piece of content, the `+` duplicated the
  "New conversation" button below it, and a destructive delete sat a pixel from that `+`. All
  gone, and the workspace name has room — it used to truncate at eleven characters. Removing a
  workspace now goes through the same dialog the launcher uses, which tells you whether files are
  deleted.
- **Sessions are one line** with a short age column (`6m` / `14h` / `4d`); the full phrasing stays
  in the tooltip.
- **The rail footer is two buttons and a readable clock**, down from four buttons and a clock
  whose time was only in a tooltip.
- **Integrations → Models & providers shows its grid on arrival.** The page title, the card and
  the collapsible inside it all said the same thing, with a chevron in front of the only content
  on the screen.

### Fixed

- **The sidebar's amber.** Five sites moved from `--accent` to `--sidebar-accent`; the active row
  is a tinted surface with a rule rather than a colour block.
- **Two composers could both open the model picker.** With the right panel widened to its Chat
  tab, `ChatInputControls` mounts twice, and `Cmd/Ctrl+J` opened a picker in each — two search
  boxes, one stealing the other's focus. Ownership is now explicit
  (`src/hooks/useModelPickerOpen.ts`), and pinned by a test that fails with "expected one open
  picker, got 2".
- **Picking a custom model could write an unresolvable identity.** The old sheet dropped
  `customModelId` on select.
- **The account menu could not be dismissed by clicking away** — it was a hand-rolled panel with
  no outside-click or Escape handling.

### Removed

- `CompactModelSearch`, `ModelPickerSheetContent`, `ui/sheet.tsx` and `atoms/uiAtoms.ts`, plus
  every unreachable "no workspace open" branch in `AppList` — the sidebar only ever renders with
  one workspace open, so a delete-all button and an add-workspace `+` described a screen that
  cannot occur. Net **−383 lines**.

**Tests:** 5,143 passing. Typecheck, lint, sandbox cross-target, i18n and edge-function checks
clean.

## [14.48.1] (2026-09-17) — The Chrome extension works in Arc, and shows its work

**Atlarix's Chrome extension did not start at all in Arc.** Not "opened without a panel" —
inert. The first statement in its background worker read `chrome.sidePanel.setPanelBehavior`,
and in a Chromium fork that has no `chrome.sidePanel` that throws before the line finishes.
Module evaluation stopped there, so the desktop bridge below it never connected either. The
report was "it downloaded, but it didn't turn on", and that was exactly right. The extension
attached to v14.48.0 still contains this; if you use Arc, this release is the one you need.

Alongside it, four things the panel was doing badly enough to notice while recording it.

### Fixed

- **Arc, and any Chromium without a side panel.** `packages/extension/src/background/service-worker.ts`
  now connects the bridge FIRST and wires the panel afterwards, behind a feature check — panel
  wiring is presentation, and a browser quirk in it must never take the desktop connection down
  with it. Ordering is the fix; the `try`/`catch` is the belt. Browsers with no `chrome.sidePanel`
  get the same document in a window from the toolbar button, which works precisely because
  `action.onClicked` only fires when no panel behaviour is registered. `shared/browser-api.ts`
  now types `sidePanel` as optional, so this class of mistake is a type error rather than a
  runtime one.
- **Tables rendered as raw pipes.** `panel/markdown.ts` treated an unhandled block as "literal
  text, which is legible", and for a table that is simply not true — a grid of `|` and `---` is
  not something a reader can align by eye. Built with `createElement` and `textContent`, no
  `innerHTML` and no dependency, because the input is model output downstream of web pages.
  Anything that is not a header row followed by a separator still falls through to plain text.
- **A streamed answer arrived in blocks.** `onText` re-rendered the whole message on every
  chunk the provider sent, so a fast model looked like it was cutting rather than streaming,
  and each chunk cost a full DOM rebuild. `panel/stream-pacer.ts` reveals the text at a rate
  that adapts to how fast it is arriving: a slow stream is not held back, and a fast one cannot
  fall more than a fixed distance behind, because a bigger backlog drains proportionally faster.
- **"I cannot see that."** The prompt's answer to this was to tell the model it was wrong,
  which does not work — it leaves the model with the instinct. It now says what the model
  actually has: `read_page` returns the whole page as text and structure, below the fold
  included, not a picture of it. `open_tab` is named in the prompt's prose for the first time;
  it had only ever appeared inside the worked examples.
- **The credit error's address was not a link.** "Top up at atlarix.dev/account" was plain
  text, so someone who had just run out of credit had to read it off the screen and retype it.
  Only that one literal is linked, and the destination is a constant — a URL a provider put in
  its own error message stays unclickable.

### Added

- **The panel keeps the model's reasoning.** It used to stream into a local variable and vanish
  the moment the answer began, so reopening a conversation showed the answer with no trace of
  how it was reached — and a report of a wrong answer had no evidence attached to it. It is now
  stored with the transcript and redrawn collapsed. Stored, never sent: `stripForWire` removes
  it at the single point messages become a request.

### Removed

- **"Allow every site" on the permission card, because it had stopped doing anything.** It
  shipped on 2026-09-15 and was correct then: host access was an OPTIONAL permission, so asking
  Chrome for `http://*/*` and `https://*/*` genuinely widened what the extension could reach.
  Host access became REQUIRED on 2026-09-17 so the desktop app never has to prompt — and from
  that moment the button was a no-op that announced success. Chrome resolved the request
  instantly against a permission it already held, showed no dialog, and the handler then
  recorded exactly one origin, which is what plain "Allow" already did. The card said "Allowed
  every site" and the next domain asked again.

  It is removed rather than rebuilt. `isGranted` is an exact-key lookup and there is nowhere
  honest to put a wildcard: an origin-shaped sentinel does not match, and the grants table's
  CHECK constraint drops one silently on sync, so making it real means a schema migration and
  account-page UI. Nothing is taken away from anyone — site grants are per-domain and
  permanent, asked once per domain and never again — so the cost is one click on each new
  domain, in exchange for losing a control that misreported what it did. `hasAllSites` and
  `revokeAllSites` went with it; neither ever had a caller outside the test file.

### Notes

- **Why CI never caught the above.** `host-access.test.ts` seeded its fake Chrome with zero
  held permissions — the optional-era shape — so the whole suite ran against a world that
  stopped existing on 2026-09-17, and one assertion had inverted into pinning the bug as
  correct behaviour. The fake now seeds the required patterns, which immediately failed two
  further tests that were also describing the old model; both were rewritten to narrow site
  access first, which is the only situation where they are meaningful now.
- A permission prompt that threw could leave the approval card hung forever with both buttons
  disabled and the turn suspended behind it. It now settles, and says it could not ask rather
  than claiming the user declined.
- Corrected a comment in `bridge/serve.ts` that justified the ungated desktop path by saying
  the desktop's "own approval flow ran before the request was sent". There is no such flow —
  verified end to end. The path is ungated on both sides; the panel path is the one with gates.
- Tests: 5,140 passing. Nothing in the desktop app changed — this release exists to get the
  extension fixes out, and the extension's version is the app's by design.
- The extension is attached to this release as `atlarix-extension-14.48.1.zip`.

## [14.48.0] (2026-09-17) — Atlarix can drive the browser you are already signed into

**The browser tools take a `target`.** `browser_inspect` and `browser` now accept
`target: "app" | "chrome"`. `"app"` is the default and unchanged — Atlarix's built-in browser.
`"chrome"` acts on **your own browser**, through the Atlarix extension: your logins, your
cookies, your open tabs. Asking "am I signed in to GitHub, and as who?" now has an answer,
because the page being read is the one your session actually loads.

The transport for this had existed and been tested for weeks. What was missing was the seam:
`bridge()` had **zero production callers**, so the user's browser and the user's agent could
not meet.

**It works beside you, not on top of you.** Atlarix works in its own tab group: it prefers its
own tabs rather than whichever one you just switched to, reuses its tab instead of opening one
per navigation, never takes focus, and never closes a tab it did not open. Every page it
touches shows a green frame, and clicks and typing draw a visible pointer.

**It no longer asks permission per site when you drive it from the desktop app.** You approved
the action in the app; being asked again in a browser window you are not looking at is the same
decision relocated to where you cannot answer it. The extension's own in-browser agent is
unchanged and still asks per site.

**Real keystrokes, and the page console.** `key` and `hover` work over the bridge — Enter
actually submits a form, and `:hover` menus actually open. `mode:"console"` and
`mode:"network"` read what the page logged and requested. Both report "Atlarix could not watch
this tab" separately from "the page produced nothing", because an empty console read that means
the former is the worst answer a debugging tool can give.

**The extension ships with every release.** Its version is now the app's version, and the zip
is attached to the release like any other asset, so "which extension goes with this build" is
no longer a question anyone has to answer.

**Four defects fixed, each a silent wrong answer rather than an error:**

- Bridged `scroll` sent arguments the page kernel never reads, so every scroll went down one
  viewport — never up, never to top or bottom.
- Reading a page's text could return the contents of its `<script>` tags as if it were prose.
- The "Atlarix is working here" frame was faded in from `requestAnimationFrame`, which does not
  fire in a background tab — so it was created invisible and reported as success by every layer.
- A test double did not model Chrome's permission-pattern matching, which made the main path of
  the feature untestable.

**5,097 tests pass**, up from 5,001.

## [14.47.0] (2026-09-16) — Onboarding runs at all now, and the light theme has surfaces

**The first-run wizard has never been seen by anyone, and that is fixed.**
`onboarding:get-completed` answers "completed" when nobody is signed in, and a brand-new
user is always signed out at the moment the wizard's gate runs — it is mounted globally and
renders on the sign-in screen. So the wizard read that answer as "already onboarded", marked
itself complete and returned without ever opening. It also never reached the code that
records completion on the server, and that server flag was what the in-app tour waited for.
One ordering bug took out both onboarding surfaces, for every user, since v10.

**Onboarding now guides you in place instead of sending you away.** The wizard used to hand
you off to other screens to read about features. It finishes on the chat screen and hands
over to a short guided tour that spotlights the real control and names its real shortcut —
Shift+Tab for work modes, Cmd/Ctrl+J for the model picker.

**Saving an API key now offers to use it.** The default model is Atlarix Core and nothing in
the app ever moved it, so adding your own key changed which models were available and nothing
about which one ran — the next turn still went to Core and still spent Core credit. Saving a
key now asks whether new chats should use that provider, and names the model it would pick.

**And if you end up on Core with a key anyway, the app says so once**, pointing at the model
picker rather than leaving you to find it.

**Light mode has an elevation ladder.** Cards, popovers and the page background were
`#ffffff`, `#ffffff` and `#fafafa` — card against background measured 1.04:1 and popover
against card was the same hex, so the whole app was one flat white plane held together by a
1.25:1 hairline. Dark mode has always had real steps, which is why it looked the more
finished of the two.

### Added

- `Coachmark` (`src/components/ui/coachmark.tsx`) — an anchored hint with a dimmed, blurred
  backdrop and an optional step sequence, built on the app's own Radix popover and theme
  tokens. It generalises the pattern `ChatIntentSelector` has shipped for a while.
- A guided tour (`src/lib/onboarding/guided-tour.ts`, `src/hooks/useGuidedTour.ts`) that
  starts when the wizard finishes. Chords come from `lib/shortcuts.ts` — the same table the
  conformance test dispatches synthetic events against — so a step cannot advertise a key
  the handler does not listen for. It is recorded as seen on **every** exit, not only the
  final "Done", so abandoning step one does not bring the whole thing back next launch.
- `useHasByokProvider` — "has the user supplied a key?", which `isAnyProviderSetup()` cannot
  answer: it counts Atlarix Core as a configured cloud provider and so returns true for
  someone who has supplied nothing.
- `useSelectModel` — one writer for the chat model, replacing the same three lines
  copy-pasted across four components. The easily-forgotten half is the token-count
  invalidation, without which the context meter reports the previous model's budget.

### Fixed

- `FirstRunWizard` waits for auth to resolve and only opens for a signed-in user, so the
  signed-out "completed" answer is never consulted. `!isAuthenticated` during launch means
  "no answer yet", not "signed out", and the two are now handled separately.
- "Open Settings → AI" no longer completes the wizard on the way out. It was calling
  `finish()`, so the one user who followed the wizard's own advice to go and add a key was
  also the one user who never saw the step explaining where the model picker is.
- **"Restart onboarding guide" works.** It re-opens the wizard and clears the record of
  one-time hints, which previously had no reset path at all. It also no longer tells the
  server that a long-standing user has never onboarded.
- **Integrations is no longer a dead end.** The left rail is `showWorkspaceChrome =
selectedAppId != null` (`src/app/layout.tsx:306`), so before a workspace is picked there is
  no sidebar on any route — and this page had no back control of its own, stranding the user
  under a body that says "open a workspace from the welcome screen or sidebar" while showing
  neither. It now carries `SettingsWorkspaceNav`, which Settings has had all along.
- The wizard's last step no longer tells a returning user to open their _first_ workspace
  while the window behind the dialog shows the one they are already in.
- "Change model" in the chat config dropdown was a dead item whenever the right panel was
  open: the callback was passed as `undefined` and the handler called `preventDefault` first,
  so the click did nothing _and_ left the menu open. The prop is required now, so a call site
  cannot withhold it without a compile error.
- Deleting workspaces no longer resets onboarding state. Neither call could re-show the
  wizard; their only live effect was on the tour.
- Light theme: a real ladder (`#f1f4f2` background against white surfaces, 1.11:1, matching
  dark's 1.10:1), a border at 1.42:1 instead of 1.25:1, and `--input` no longer aliasing
  `--muted` so fields read as fields.
- Light theme secondary text is a neutral slate rather than `#166534`. Its contrast was never
  the problem (6.8:1); its hue was — a mid-green sitting 1.89:1 from the primary green, so
  every piece of muted copy read as a link. The fix is hue, not contrast.
- Six components authored for dark mode only (`ToolCallCard`, `HandoffResultCard`,
  `TerminalOutputAttachmentChip`, `FixAllErrorsDialog` and others) now use theme tokens
  instead of bare `zinc` utilities, which rendered dark-on-white in light mode.

### Removed

- **`shepherd.js`**, and the tour built on it. It shipped its own stylesheet with no theme
  integration — a hard `#fff` popover and a flat black overlay, wrong in dark mode — was
  typed as a bare `declare module` so every call was unchecked, and roughly three quarters of
  its code was unreachable: the per-feature tours had no trigger anywhere in the app, and two
  of the four pointed at anchors that no longer exist in the DOM. Its first-run tour
  duplicated the wizard, which now actually runs.

### Notes

- Tests: 5,001 passing, 20 new. The regression test for the onboarding gate was written first
  and confirmed failing against the shipped code.
- The old wizard suite passed only because it stubbed `onboarding:get-completed` as
  `{ completed: false }` — the one value production cannot return for a signed-out user.
- The guided tour is two steps, both anchored in the composer row. A right-panel step was
  written and dropped: `RightPanel` returns null when hidden so its anchor does not exist, and
  its root is a flex container that a coachmark's inline-flex wrapper would visibly break.
- Not changed: the ~110 remaining bare mid-gray utilities (`text-gray-500` and friends). They
  are legible in light and merely flat in dark; converting them is a separate sweep.

## [14.46.1] (2026-09-15) — A crash that replaced the whole app is fixed

**Atlarix no longer crashes to an error card mid-answer.** Running two of the same tool at
once — two shell commands in parallel, which a sub-agent does routinely — could wipe the
one-line label off a tool card. The card is decoration, but the code that drew it assumed
the label was always there, so the missing label threw during rendering and React replaced
the entire window with "Sorry, that shouldn't have happened!". The work was not lost; the
app just stopped showing it.

### Fixed

- `mergeToolItems` in `src/lib/chat/stream-thread.ts` merged two in-flight calls to the same
  tool with an object spread, and object spread copies a property even when its value is
  `undefined` — so a newer event without a summary ERASED the one already there rather than
  falling through to it. Every other optional field on that path was re-fixed by hand right
  below the spread; `summary` was the one omission, and it is the one the renderer calls
  `.trim()` on. The other merge branch never had the bug, which is why this only appeared
  when two calls of the same tool overlapped.
- Three render sites that called `.trim()` on that label without a guard are now guarded —
  `SubAgentRunCard.tsx`, `group-stream-tools.ts` and `stream-thread.ts`. Each already used
  `?.` on the same field a few lines away. A missing one-line label must never be able to
  take the window down with it.

### Notes

- Tests: 4,979 passing. The regression test drives the real reducer and was verified to fail
  against the shipped code.
- Nothing else changed. v14.46.0's contents are unaffected.

## [14.46.0] (2026-09-15) — Atlarix makes you files, and starts speaking to your own browser

**The browser extension can build you a file.** Ask for a spreadsheet, a PDF, a CSV, an image
or a zip and it writes one, offered as a download in the conversation. There is no writer per
format and there never will be — the model writes the code, and the code runs in a sandboxed
worker with no network, no extension APIs and no access to the page. Files are held in memory
for the life of the panel and are never written to extension storage.

**Skills and connectors you set up on atlarix.dev now work in the desktop app.** The account
page has said "available in the app, the browser extension and the CLI" for a while; the app
was not a participant. It is now. A connector's credential still never reaches your machine —
the app asks Atlarix Core to make the call.

**The agent stops losing your tab.** A question about the page you were on keeps meaning that
page for the whole turn, even if you switch tabs while it works. Previously every tool that
took an optional tab id silently re-pointed at whatever you were looking at now.

**Revoking a site takes effect on the next turn.** Revoking from the account page used to
apply only when the extension's panel regained focus, which read as a request that hung. It is
now applied at the top of every turn.

**"Allow every site"** is offered alongside per-site permission, for research across domains
nobody can name in advance. It goes through Chrome's own dialog and grants only Chrome's half —
Atlarix still asks before working on a site you have not allowed.

### Added

- `run_code` in the extension: a manifest-sandboxed page plus a blob worker, `emit()` for files
  and `zip()` for the OOXML container. `packages/extension/src/sandbox/`,
  `packages/extension/src/tools/run-code.ts`, `packages/extension/src/files/store.ts`.
- Account skills and connectors on the desktop: `src/lib/skills/account-skills.ts`,
  `src/lib/mcp/account-connectors.ts`.
- Chrome Web Store auto-deploy: `scripts/cws-submit.mjs`, `scripts/cws-auth.mjs`, a monthly
  keepalive, and `scripts/cws-copy-check.mjs` (field limits, and the line shape that got v1.0.0
  rejected for "excessive keywords").
- The desktop↔extension bridge transport: `native/atlarix-bridge` (a dependency-free Rust
  native-messaging relay), `src/lib/bridge/`, `src/main/bridge-lifecycle.ts`,
  `packages/extension/src/bridge/`. **Dormant in this release** — the `target:"app"|"chrome"`
  seam in `src/lib/tools/browser.ts` is not built, so no tool reaches it.

### Changed

- Extension manifest gains `nativeMessaging` and `alarms`, a second sandboxed page, and
  `worker-src blob:` on the sandbox CSP (`child-src 'none'` alone blocks workers, and Chrome
  reports that as a bare error event with no message).
- `formatCents` groups thousands, and `PRO_SUMMARY` matches the website word for word — it
  claimed to and did not.

### Fixed

- `build-msix` now depends on `build-linux`, not `quality` alone. It raced the job uploading the
  artifact it downloads, and because that download is `continue-on-error` the miss surfaced two
  minutes later as a missing `atlarix-sandbox-linux` — which reads like a packaging bug. This
  stranded v14.45.0 as an invisible draft.
- The Windows CI runners are un-pinned to `windows-latest`.

### Notes

- **There is no v14.44.0.** It was never tagged and has no changelog section; the work folded
  into v14.45.0. `docs/TODO.md` claimed it shipped, which is corrected in this release.
- Tests: 4,974 passing. `oxlint` reports zero errors across `src`, `packages` and `scripts`.
- The session store no longer throws when it cannot resolve where the session lives. It is
  handed to `@supabase/auth-js`, whose constructor starts a session recovery it does not
  await — so a throw there escaped every `try`/`catch` and surfaced as an unhandled
  rejection. It now reports UNAVAILABLE, which is the one answer that does not license
  overwriting a real session.

## [14.45.0] (2026-09-09) — The app is free, the meter is honest, and skills live in your repo

**Atlarix is free.** Every feature is available on every plan — nothing in the app is
behind one any more: MCP servers, automations, skills, sub-agents and workspaces all just
work. The per-workspace limits that remain (10 MCP servers, 10 automations) are there
because a workspace with fifty MCP servers is one nobody can reason about, not because
somebody has not paid. Bringing your own key or running Ollama locally is metered by
nobody. **Pro is not a feature tier** — it adds Atlarix Reviewer and a monthly Atlarix
Core allowance, over one shared balance.

**A new Core lineup: GLM 5.3, GPT 5.6 Terra, and GPT 6 Astra.** New accounts start on the
reasoning tier rather than the budget one. Because a Core slot names a SLOT and never a
model, the lineup can change without you updating the app — and when the model behind a slot
does change, Atlarix now tells you instead of quietly answering in a different voice.

**The wallet refuses instead of guessing.** A request you cannot afford is declined up front
with the amount it would take, rather than being clamped into something smaller that then
fails halfway through.

**A cancelled turn no longer overcharges you.** Stopping a generation used to bill the
worst case — the whole output budget the model was allowed, not the two seconds it actually
produced. The same request measured 45c completed and 58c cancelled. It is now priced from
what was really generated, and it can never cost more than the estimate you were quoted.
If the connection drops rather than you cancelling, the same applies.

**A dropped connection retries instead of blaming the model.** A brief network reset used to
end the turn with "Something went wrong — please try again", after two silent retries that
told the model to stop thinking and answer — to a socket that was already dead. The retry
that was supposed to handle this could never fire. Now a reset backs off and reconnects, and
the answer arrives. Nothing is shown to you at all when it recovers.

**Running out of credit stops the whole round, not just one worker.** When a turn had
several sub-agents running and the credit ran out, one of them failed and the rest carried
on spending. Now the round halts together, and queued work is dropped rather than started.

**Skills are files in your repo, and the in-app marketplace is gone.** A skill is a markdown
file in `.atlarix/skills/` that teaches Atlarix a repeatable job — write one, or ask Atlarix
to write it for you, and commit it alongside your project docs so everyone working in the
repo gets the same behaviour. The registry browser is removed: the skills that earn their
place turned out to be the ones specific to a codebase, not generic ones fetched from a
list. Settings → Skills now shows what a workspace has and lets you read any of them.
Skills you installed previously stay on disk; nothing is deleted from your repository.

**Project rules can be more than one file.** `.atlarix/rules/` holds as many as you like and
they all apply — testing, style, the way your migrations get written. The older
`.atlarix/atlarix.md` keeps working exactly as before.

**Atlarix can bring your setup across from another AI coding tool.** Point it at a config
from Cursor, Copilot, or something we have never heard of, and it will read it and offer to
carry it over — rules become a file in `.atlarix/rules/`, and MCP servers are proposed one
at a time for you to approve. It never adopts another tool's configuration on its own, and
it never adds an MCP server without asking: approving one means Atlarix will run that
program on your machine, so the approval shows you the exact command.

**A project can no longer change how Atlarix behaves without telling you.** A repository was
able to ship a file that silently replaced Atlarix's own operating instructions for every
turn — including a sub-agent's, one that can edit files. Cloning someone's project was
enough. That is fixed: those instructions now always come from Atlarix itself. Relatedly,
changes to files under `.atlarix/` ask for approval instead of being written silently,
because those files decide how the agent behaves in future sessions.

**Reasoning reaches its top settings on GPT models.** The highest two effort levels were
unreachable — asking for them silently sent a lower one.

**Atlarix speaks your language again.** Every translated string in the app was returning its
own name instead of the translation. If you had picked a language other than English in
v14.43, this is the release where it works.

**Smaller things.** A tip under the composer, labelled so it reads as a tip, and a shortcuts
list in Help you can actually find. The context ring spins smoothly while a turn streams. A
failed first turn no longer leaves a session permanently called "Untitled". Pressing Stop, or
recovering from a network blip, no longer files an error report. A single failed fetch of the
Core lineup no longer hides a lineup change until restart. Atlarix also spends fewer tokens
describing itself each turn — it now tells the model how many skills and MCP servers a
workspace has rather than listing them, and says nothing at all when there are none.

**For the record:** signing in is still required. Bring-your-own-key and local Ollama are
free of metering, but not usable anonymously — that is deliberate.

## [14.43.0] (2026-09-08) — It speaks your language

**Atlarix answers in your language.** Thirteen of them — English, 简体中文, Français,
Deutsch, हिन्दी, Italiano, 日本語, 한국어, Polski, Português (Brasil), Русский, Español,
Türkçe — picked in Settings → General → Language, or left to follow your system.
Code, file paths, shell commands and identifiers stay in their original language,
because translating those produces code that does not run. English installs pay
nothing for this: the instruction is only sent when you are not on English.

**Session names and attachment filenames survive your alphabet.** Both were
cleaned with a rule that only understood A–Z, so everything else was replaced with
spaces or underscores. A Russian conversation was named "gitignore" — the one Latin
word in the title — and a Chinese one lost its name entirely; a file called
отчёт.pdf became `_____.pdf` in the attachment chip. German and Turkish were
mangled from the inside, which is worse, because "F ge gitignore hinzu" still looks
like a title. Every script we ship is now kept intact, combining marks included, so
Hindi is no longer taken apart syllable by syllable.

**Reopening a workspace lands on a fresh chat, and the chat you are in is
clickable.** It used to resume the most recently touched session — which, because
reopening reuses an existing empty one rather than piling up new ones, could be
days old and sit third in the list. Worse, clicking the row you were already in did
nothing at all, so the top session looked broken until you clicked a different one
and came back.

**Deep web search stops throwing away most of what it fetched.** It read up to five
pages and delivered one. The other four were fetched, waited for, and discarded
unread — while the result announced that it had "analyzed 5 pages in depth". The
model could see the truncation and worked around it by searching again, which is
why answers sometimes took several searches to arrive. Every page now contributes,
each says how much of it you are seeing, and the agent can pull any of them in full
with one follow-up read.

**Settings and Integrations lost their duplicate menu.** Both pages had a sidebar
list and a row of tabs saying almost the same thing. The tabs remain; the sidebar
is gone, and nothing became unreachable — the two lists were identical.

**Unsent text is no longer lost.** A message you typed but did not send survives
switching sessions and quitting the app, and it belongs to the conversation you
typed it in rather than following you around.

**The new-window button and the clock moved to the left rail**, so they are
reachable from every screen instead of only from Home.

**A setting changed in one window now reaches every window.** Each window used to
load settings once and never hear about later changes, which is why zoom could
differ between two windows of the same app until one was reloaded.

## [14.42.0] (2026-09-03) — Talk to it while it is working

**A message you type mid-turn now reaches the turn that is running.** It used to be
parked until the turn ended and then replayed as a brand-new one — and only one
message fitted. A second was silently rejected, with no feedback at all, because
Enter bypasses the disabled Send button, so your text just sat in the box. Now
each message is handed to the running turn and arrives on its next step, and it
appears in the transcript the moment the agent takes it. Type as many as you like;
each stays cancellable until it is picked up. If the turn ends before one can be
delivered, it opens the next turn instead — never both, and never neither.

**Answering a question no longer needs a Stop.** The question tool deliberately
ends the turn, and the queued-message flush ran at exactly that moment — so a
message you had typed started a fresh turn on top of the question card, and
pressing Stop was the only way back to it. That Stop then latched the chat as
stopped, and releasing the latch required a non-empty prompt, which an answer
never sends because the answers travel out of band. One question round could
leave a chat latched for good: five sub-agents finished over the following five
minutes and every one of their wakes was refused. Commands, automations and
scheduled self-wakes all lost the same eager delivery. Their results were never
lost — only the automatic pickup was.

**Sub-agent cards finish counting.** A card could sit on "4/5 running" after all
five had in fact finished, because the listener that would have settled it
unsubscribed when the turn ended, leaving the completion events that arrived
afterwards with no receiver.

**Your own messages stopped glaring.** The bubble borrowed the button colour —
full-saturation emerald — and in dark mode the near-black text it was meant to
pair with never applied, because the markdown inside forces light prose text. The
result was white on full emerald, the highest-glare pair the palette can produce.
The bubble now has its own surface colours: deep emerald in dark mode, a pale
tint in light, with a border to keep its edge legible.

## [14.41.0] (2026-09-02) — The context meter starts telling the truth

**The context meter was hiding about 10,000 tokens.** It counted the system prompt and
nothing else, so the tool descriptions and parameter schemas that ship on every single
turn — and are billed on every single turn — were invisible to it. In Build mode the real
fixed cost of starting a turn is around 14,600 tokens; the meter said about 4,000. It now
counts the whole thing and breaks it into three lines you can read: the instructions, the
tool descriptions, and the tool schemas. It also names which work mode it priced, because
Build and Plan genuinely cost different amounts.

**And it was pricing the wrong mode.** The meter worked out your work mode with its own
copy of the logic, which had two faults: it fell back to a prompt shape that no real turn
has ever used, and it read your global mode preference even though each chat has owned its
own mode since v14.36.0 — so a chat set to Debug could be measured as Explore. It now asks
the same question the same way the turn itself does.

**The agent stops being shown settings it cannot change.** Four tools advertised parameters
that the app fills in itself and overwrites — a workspace id, a session id — so the model
was paying for them on every turn and being invited to guess values that were thrown away.
Those are gone from what the model sees, while the app keeps filling them in exactly as
before.

**Fewer wrong ways to call the same tool.** Reading a file offered three different ways to
ask for part of a file, and several tools carried a second name for a parameter they
already had. The extra spellings are no longer advertised, so there is one obvious way to
do each thing — and every old spelling still works, so nothing that already knew the older
name breaks.

**Tool parameter help now arrives the same way tool descriptions do.** For the tools a given
mode rarely uses, the long parameter notes are shortened to their first line, with the full
text one call away. The tools each mode leans on — running commands, editing files,
delegating work — keep their parameters in full, because that is where getting a parameter
wrong costs the most.

**Six browser tools became two.** Driving a page took one tool to navigate, another to
click and type, another to manage tabs, another to find an element, and another to run
several of those in a row — five tools for one job, and every one of them described in
full on every turn. There are now two: **browser_inspect** to read a page, and **browser**
to act on it (`action: navigate / find / click / fill / key / hover / scroll / tabs /
batch`). Reading and acting stay apart on purpose — reading is free and repeatable, acting
changes something.

The act tool no longer takes a CSS selector, only an element reference from a page read.
A selector that matches the wrong element succeeds quietly on the wrong thing; a stale
reference fails loudly and tells you so. All five old names still work.

Measured on the wire, per mode: Explore 11,539 → 10,875; Plan 10,891 → 10,310; Build
15,329 → 14,644; Review 11,199 → 10,526; Debug 14,738 → 14,053. Every mode is smaller than
it was, and every mode also gained the two mobile tools below — the browser consolidation
on its own was about 10%, and roughly half of that was spent on being able to see a phone.
A new check fails the build if the fixed prompt grows past a ceiling — or shrinks below a
floor, since a mode that quietly stops offering a tool looks exactly like a saving.

**Settings is two pages now: Settings and Integrations.** Settings had become one long
scroll doing three unrelated jobs, with model providers sitting next to appearance and
telemetry. The new split is by KIND, not by scope:

- **Settings** is how the app behaves for you — General, Diagnostics, Browser, Search,
  Notifications, Voice input, Community, and the danger zone.
- **Integrations** is a new page in the sidebar, alongside Apps, Tools and Settings. It
  holds everything Atlarix is connected to and what it may do there: Models & providers,
  MCP servers, Skills, GitHub, and this project's permissions. Each is its own screen
  rather than another section on a long page.

Nothing was removed, and every deep link still lands somewhere sensible: an MCP sign-in
prompt now opens Integrations → MCP servers, and a model error opens Integrations →
Models & providers.

**The token budget cap can be cleared again.** Deleting the last digit put the old value
straight back, so the only way to remove a cap was to type a second digit and then delete
the first — which left a `0` on screen while the provider was actually back on automatic.
The field now clears properly, says which state it is in ("No cap — using the model's full
context window" or "Capped at 50,000 tokens"), and has a **Use auto** button so getting
back to automatic is one click rather than a guess. A number below the minimum is raised to
it and you are told, instead of being silently thrown away.

**Atlarix can see a phone screen now.** It could already build a mobile app and run its
build commands, and then had no idea what it had drawn — a web app it can drive end to end,
a mobile app it could only compile. Two new tools close that, in the same shape as the
browser pair: **mobile_inspect** reads a running Android emulator or iOS Simulator, and
**mobile** acts on it (tap, type, key, swipe, launch).

The default read is the UI hierarchy **as text** — every element with a reference, a few
hundred tokens — not a screenshot. A screenshot is thousands of tokens and answers fewer
questions; it is there for when you genuinely need the image. Actions address elements by
reference, never by coordinate: a coordinate is right for one screen size and taps empty
space on every other, and it fails by _succeeding_, which is the worst way for a test to
fail.

iOS is honest about what it cannot do. Screenshots and logs work; the hierarchy and input
injection do not, because Apple's simulator tooling has no equivalent — so those calls say
exactly that, and say not to retry, rather than failing in a way that invites the agent to
try again.

Reading a device's log takes an app name, and it is worth giving it one: a phone's log is the
whole operating system, and naming your app is the difference between megabytes of system
chatter and the few lines that are actually your crash.

**Both are available in every mode**, from Explore to Debug — the same reasoning that keeps
the browser everywhere: driving an emulator changes the state of a device, not your project,
so Plan's read-only rule is untouched, and "what does this look like on a phone" is a
question rather than a build step. They stay affordable because the progressive reveal
already introduced this release applies to them: every mode binds one sentence and a pointer
to the full instructions, not the whole description.

They are **not** offered where there is nothing to look at: the headless command-line agent
has no emulator, and an unattended automation has nobody watching one. That is now checked by
a test that names the tools rather than matching a prefix — the previous version of that check
matched `browser_` and so quietly stopped covering the consolidated `browser` tool.

**And you can watch it work.** Driving a page already draws a visible pointer, a ring around
each target and a label naming the action. An emulator is a separate window Atlarix cannot draw
on, so it uses Android's own equivalent instead: the first time Atlarix taps in a session it
turns on the system touch indicator, tells you it did, and puts the setting back the way it
found it when Atlarix quits. A device that already had it on is left alone.

The arithmetic for Build: six browser tools plus nothing for mobile became two browser tools
plus two mobile ones. Fewer tools, more that Atlarix can actually see.

**"Clone repo" is gone, and that is the point.** It signed you in to GitHub, stored a
second GitHub token, and cloned a repository — which meant it worked for GitHub and could
never work for GitLab, Bitbucket, a self-hosted server, or a plain SSH remote. Cloning
already works everywhere through the terminal, using the credentials you already have
(your SSH keys, your credential helper, `gh` or `glab`) — credentials Atlarix never has to
hold. Open a folder, then ask the agent to clone into it, on any host.

This also retires the token people kept confusing with signing in to Atlarix. **Signing in
with GitHub is untouched** — that goes through Supabase and never used this credential.

**The Automations "GitHub event" trigger is gone for the same reason.** It was a
purpose-built poller for one company's API. Polling for a new pull request, a mention, or
a finished job is the same problem on every host, and Atlarix already has the general
answer: an **MCP trigger** can poll any API, and a schedule plus a command covers the
rest. Automations now has schedule and MCP triggers. An existing automation on the removed
trigger is disabled and tells you why, rather than sitting enabled and never firing.

**Two defects found while doing the above, both in the same seam.** Retired tool names are
supposed to keep working, and the registry did map each old name to its new tool — but the
code that dispatches a tool call checked the model's name against the list of _current_
tools first, so an old name died there as "Unknown tool" and the mapping was decoration.
That is fixed. And once old names actually run, a permission rule you wrote against one had
to keep biting: a rule denying `browser` now also stops the retired names, and a rule you
already wrote against a retired name still stops that. Both directions are checked, so
adding a name can only ever tighten the rule, never loosen it.

**You can see compaction happen now — whichever way it starts.** When a turn gets long,
Atlarix summarises its own context to keep going: a pause of several seconds during which the
screen said nothing at all, indistinguishable from a hang. It now shows a pulsing "Compressing
context…" while it works and the before/after numbers for a few seconds after, then gets out of
the way and the turn continues. Mid-task, start or end.

When it finishes it leaves ONE line behind — "Context compressed · 120000 → 40000 tokens" —
rather than the two stacked rows an earlier build of this release produced, and a run in Build
mode now shows that it started at all.

Compaction can begin three ways — automatically before a turn is sent, part-way through a long
turn, or because the agent asked for it — and each one had been announcing itself differently.
The one that fires automatically, which is the one you are most likely to notice as an
unexplained pause, announced itself in a way nothing displayed. All three now report through
one path, so a pause is always explained and the wording is always the same. A run that finds
nothing worth compacting says so, rather than claiming it compressed something.

**Filling a form field works on more pages.** A page's element references can point at a
WRAPPER rather than the field itself — a search box whose visible part is a container with
the real input inside it, which is how most modern component libraries are built. Filling
one of those failed with "Illegal invocation", a message that told the agent nothing, so it
retried, tried a workaround, and concluded the browser tools were broken. It now finds the
field inside the wrapper and fills it; when there genuinely is no field, it says what the
element actually is and what to try instead.

**Reading a tool's instructions shows the instructions.** Atlarix keeps long tool
documentation one call away rather than in every prompt, and the card for that call
displayed a single word: "Done". It now shows which tool was asked about and what came back,
and the activity row names the tool instead of reading "Read tool usage" every time.

**Settings and Integrations tabs stay on one line.** With eight sections, "Danger zone"
wrapped onto a row of its own, which reads as a separate group rather than the last tab —
and made the page's layout shift as you resized the window. The tabs now scroll sideways
with arrows on either end, like the sheet tabs in a spreadsheet, and the arrows appear only
when there is something in that direction.

**Releases now ship the dependency versions that were tested.** The packaging step is supposed
to install the app's runtime dependencies at the exact versions in the lockfile. A shadowed
variable made that check fail every single time, silently, so each build installed whatever was
newest at the moment it ran. Nothing is known to have broken because of it, but a release should
contain what was tested, and now it does.

**"Tool failed" no longer appears where nothing failed.** Two of the most common results in a
long session were being reported as errors: compacting a context that is already small
("nothing worth compacting" — a correct answer), and the guard that stops the agent repeating
an identical call ("this call was NOT executed; change your approach" — a protection working).
Both wrote a clear explanation of themselves, in a field the card did not read, so both showed
a red "Tool failed" with the real reason discarded — under a green checkmark, because the call
itself had completed. One row managed to be wrong in both directions at once.

Cards now read every field a tool uses to explain itself, and a call that was declined or had
nothing to do is shown as ordinary text rather than an error. The compaction row says "Context
already compact" when that is what happened, instead of "Context compacted".

**Small things found along the way.** Settings said "Compass is built in" where it meant
Atlarix Core. The MCP page opened with three Linux-only sandbox controls, above the form
for adding a server; they are now under "Advanced" at the bottom. The sidebar's settings
list can no longer point at a section that does not exist — that used to be caught by a
comment asking people to remember, and is now caught by a test.
