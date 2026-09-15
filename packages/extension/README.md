# Atlarix Browser Extension

Drives the user's **own** browser — the session they are already logged into —
and hosts its own chat. Two products over one page-control layer:

1. **Standalone assistant.** The extension is the primary chat surface, for people
   who have neither the desktop app nor the PR bot. Atlarix Core only.
2. **A hand for the desktop app.** Any model in the app — Core, your own key, or a
   local Ollama — drives your real browser as a tool.

## Why an extension at all

Both cheaper routes are closed, and were measured shut rather than assumed
(2026-09-07, `docs/TODO.md`):

- **CDP attach** — Chromium ≥136 refuses `--remote-debugging-port` on the default
  user-data-dir. A debug port is obtainable only on a fresh profile, which by
  definition holds none of the user's logins.
- **Cookie import** — Chrome 127's App-Bound Encryption ties cookie decryption to
  Chrome's own app identity.

## Build and load

```
npm run build:extension
```

Writes two things under `packages/extension/dist/` (gitignored):

- `unpacked/` — load this via `chrome://extensions` → Developer mode → **Load
  unpacked**.
- `atlarix-extension-<version>.zip` — what goes to the Chrome Web Store.
  `manifest.json` sits at the archive root, which is the commonest way a first
  upload is rejected, so the build asserts it.

The build needs `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` — the same names
`vite.main.config.mts` reads, so one `.env` serves the app and the extension.
Missing either is **fatal**, never defaulted to an empty string: an extension
built with a blank Supabase URL installs and opens perfectly and then fails at
sign-in with a bare fetch error, ten steps downstream of the mistake. Pass
`--allow-missing-config` to build the shell without them.

The zip is **reproducible** — entries are written in sorted order with a fixed
1980 timestamp — so "did the artifact actually change" is a checksum rather than
a guess.

## What it does today

The side panel is a chat. Sign in with Google or GitHub, pick a Core tier, and
ask about the page you are on. Six tools, and the list is short because the
kernel is still reads-only:

| Tool           | What it does                                                      |
| -------------- | ----------------------------------------------------------------- |
| `read_page`    | the page's controls and text, each line carrying a stable `[ref]` |
| `find_on_page` | ranked matches for a phrase, for when the page is long            |
| `list_tabs`    | ids, titles, URLs, and whether each is allowed                    |
| `open_tab`     | opens a URL into Atlarix's own tab group and waits for it         |
| `close_tab`    | only tabs in that group — the user's own are not ours to close    |
| `remember`     | one durable fact, injected into later conversations               |
| `recall`       | search or read what was said earlier, here or in past conversations |
| `web_search`   | ranked links, read off a real results page and the tab closed     |

**`web_search` shipped in Phase 4, and the reason it is a tool rather than an
instruction is a measurement.** On the desktop, 2026-08-19: a real browser tab
returned 24/29/25 results on three developer queries where DuckDuckGo's Instant
Answer API and five public SearxNG instances returned 0/0/0. Every zero was an
"is this a real browser?" check — a rate limit, a challenge page, a verification
interstitial — and a `fetch` cannot pass any of them.

That makes this extension the best-positioned surface Atlarix has for search: it
is not a headless Chromium pretending to be a browser, it is the user's actual
browser with their actual profile. The thing every challenge is testing for is
simply true here.

The tool opens a results page in the agent's group with `active: false`, injects
the shared kernel's `search-results` op, and closes the tab in a `finally`. The
tab is scaffolding, not a result — which is the opposite of the rule for
`open_tab`, where a page the agent opened for the user stays open.

**It cannot click or type yet.** `PageRequest` in the shared kernel is
`snapshot | find`; the action ops land in Phase 3. No `click` tool is declared,
because a model given a tool will use it, and every attempt would cost a round
and end in an apology. The read result says outright that acting needs the
desktop app.

Page text comes back inside the same `<untrusted-data>` envelope the desktop
uses, tagged with its origin, and the system prompt carries the clause that says
what the envelope means.

## One contract, two backends

The model will eventually see ONE tool surface across both (`browser` /
`browser_inspect`, with a `target`) — that is Phase 3, and today the two
surfaces have their own tool names over shared page code. What already holds is
the layer underneath: both backends run the _same_ page-realm code from
[`src/lib/browser/page-scripts`](../../src/lib/browser/page-scripts/index.ts) —
the walker, the `data-atlarix-ref` registry, the find ranker, the fill-target walk.
Change ranking or ref semantics THERE, never here.

**How that code reaches the page differs, and the difference is not cosmetic.**
The in-app browser passes a string to `executeJavaScript`. An extension cannot:
`chrome.scripting.executeScript()` takes `func` or `files` and has no `code`
property, MV3 removed the one MV2 had, the extension CSP forbids `unsafe-eval`,
and in `world: "MAIN"` an `eval()` runs under the _page's_ CSP — which GitHub,
Google and most banks block. There is no route that executes a string here.

So the sharing happens one level up. `atlarixPageKernel` is a real **function**:
the extension hands it straight to `executeScript` with JSON-serializable
`args`, and the desktop splices its `.toString()` into an `executeJavaScript`
string. One implementation, two transports, and the shapes cannot drift because
there is only one of them. `src/types/chrome.d.ts` already declared exactly that
shape — the typings were right while the prose was wrong.

Two rules follow, and both are enforced by test:

- **Zero imports**, pinned by `src/__tests__/page-scripts-portable.test.ts` —
  an `import` that is invisible on the desktop is fatal in a page realm.
- **Zero module-scope references.** A stringified function cannot close over its
  module. This is the same rule one step further, and it is new: it did not
  matter while the scripts were literal strings. Guarded three ways —
  `page-scripts-portable.test.ts` derives the module's own bindings and asserts
  none appears in the kernel source, `renderer/page-scripts-injectable.test.tsx`
  evaluates it in global scope where those bindings do not exist, and
  `page-scripts-bundled.test.ts` runs both real bundlers (esbuild for this
  package, Vite/Rolldown for the desktop) and checks the output the same way.
  The bundler settings are pinned by evidence rather than by comment: one case
  turns `keepNames` on and asserts it **breaks**.

`world: "MAIN"` is required rather than preferred — the ref registry is a WeakMap
on `window`, and an isolated world would hand every read a fresh, empty one.

The text the model reads is shared too, as of Phase 2:
[`src/lib/browser/a11y-format.ts`](../../src/lib/browser/a11y-format.ts) renders
a snapshot for both surfaces. It was extracted from `a11y-snapshot.ts`, which
types its first parameter as `Electron.WebContents` and so cannot be imported
here at all. The act hint is a parameter, because the desktop can click and this
cannot.

## Permissions, and why each one is there

`src/types/chrome.d.ts` declares the API surface we call; `manifest.json` asks
for the subset that shipped code actually uses **today**. Those two lists are
deliberately different, and the gap closes one commit at a time — a manifest that
asks for `debugger` before a line of code uses it makes the justification list a
fiction on day one. Nobody has this installed yet, so a permission added later
costs nothing.

| Declared now | Why                                                                            |
| ------------ | ------------------------------------------------------------------------------ |
| `identity`   | `launchWebAuthFlow` — the PKCE sign-in                                         |
| `storage`    | `storage.sync` for site grants, `storage.local` for the session and history    |
| `sidePanel`  | the UI, the agent loop, and the only context with a user gesture               |
| `tabs`       | `list_tabs`, `open_tab`, `close_tab`, and waiting for a page to finish loading |
| `scripting`  | injecting the page kernel — the only way an MV3 extension can read a page      |
| `tabGroups`  | the agent's own tabs, visibly separated; closing the group is the stop gesture |
| `debugger`   | trusted keyboard and pointer input, which nothing else can produce             |

Declared in `chrome.d.ts` but **not in the manifest**: `offscreen` and
`windows`. `windows` needs no permission string at all — `windows.getCurrent()`
is free, and the panel uses it to know which window the agent's tab group
belongs to.

`offscreen` is the interesting absence. It was in the plan as the home for the
agent loop, and it is not, for a reason found by reading the API:
`offscreen.createDocument` takes a `reason` from a **closed enum** —
`AUDIO_PLAYBACK`, `BLOBS`, `CLIPBOARD`, `DOM_PARSER`, `DOM_SCRAPING`,
`IFRAME_SCRIPTING`, `LOCAL_STORAGE`, `WORKERS` and some device APIs. None of
them means "run a long job", and the field is shown to the Web Store. Declaring
`WORKERS` and then spawning a worker so the claim is technically true is not
something this extension does.

So the loop runs in the **side panel** — an ordinary document with no idle
death. The service worker was never a candidate: Chrome's own lifecycle
documentation states a `fetch()` whose response takes over 30 seconds
terminates the worker, and a streamed model turn is exactly that fetch. The
cost of the panel is stated rather than hidden — closing it ends the turn in
progress — and the transcript is saved after every round, so reopening shows
everything up to the last completed one.

**Host access is held at install; the GATE is the allow-list.**
`host_permissions` is `<all_urls>`, so Chrome never prompts per origin. The
decision the user actually makes lives in
[`src/permissions/site-grants.ts`](src/permissions/site-grants.ts): the agent
asks the first time it needs a site, one origin at a time, and reads nothing
until the answer is yes.

This was the other way round until 2026-09-15, and the swap is worth
understanding. A grant used to be BOTH a Chrome permission and our own record,
and keeping two halves from lying about each other is what produced almost
every awkward thing around it — a user-gesture constraint, a reconciliation
pass, and a revocation from the website that could not take effect until the
panel was next focused, because a web page cannot call
`permissions.remove()`. One record has one truth, and revoking now applies on
the agent's very next action.

**What got weaker, and it should be said plainly.** `permissions.request()`
needed a user gesture, so the agent loop *structurally* could not widen its own
reach. `grantSite` is an ordinary storage write, so that property is now
conventional: the loop returns `needsApproval` and awaits a boolean, and the
only caller of `grantSite` is the approval card's click handler. This is the
posture Claude Code and the Claude extension ship, and it is weaker than what
it replaced.

**Chrome can still withhold a site**, from `chrome://extensions → Site access`,
and declaring a permission is not holding it. There is no event for this — the
injection failure is the only signal — so
[`src/page/inject.ts`](src/page/inject.ts) translates exactly that refusal into
the setting and the path, and leaves every other failure wearing Chrome's own
words.

There are still **no declared content scripts**. Injection happens on demand,
into a tab whose origin the user has allowed.

## No new dependencies

This package deliberately has none. Chrome's API surface is declared by hand in
[`src/types/chrome.d.ts`](src/types/chrome.d.ts), covering only what we actually
call — which doubles as the justification list for the Web Store review.

`esbuild` is a root **devDependency**, not a dependency of this package: it
builds the bundle and ships none of itself. Nothing enters the CRX that is not
written here.
