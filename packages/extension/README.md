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

## One contract, two backends

The model sees ONE tool surface (`browser` / `browser_inspect`, with a `target`).
That holds because both backends run the _same_ page-realm code from
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

## Permissions, and why each one is there

`src/types/chrome.d.ts` declares the API surface we call; `manifest.json` asks
for the subset that shipped code actually uses **today**. Those two lists are
deliberately different, and the gap closes one commit at a time — a manifest that
asks for `debugger` before a line of code uses it makes the justification list a
fiction on day one. Nobody has this installed yet, so a permission added later
costs nothing.

| Declared now | Why                                                             |
| ------------ | --------------------------------------------------------------- |
| `identity`   | `launchWebAuthFlow` — the PKCE sign-in                          |
| `storage`    | `storage.sync` for site grants, `storage.local` for the session |
| `sidePanel`  | the UI surface, and the only context with a user gesture        |

Declared in `chrome.d.ts` but **not yet in the manifest**: `tabs`, `tabGroups`,
`scripting`, `debugger`, `offscreen`, `windows`.

**Host access is optional, not granted at install.** `optional_host_permissions`
is `http://*/*` and `https://*/*` — not `<all_urls>`, which would also cover
`file://` and `ftp://`, schemes `originOf` in
[`src/permissions/site-grants.ts`](src/permissions/site-grants.ts) refuses to
produce an origin for. The manifest states the rule the code already enforces.

The install prompt therefore shows **no host warnings at all**, and each origin
is requested from a side-panel button at the moment the user grants that site.
That upgrades a site grant from a record of intent into something Chrome itself
enforces — and because `chrome.permissions.request()` needs a user gesture and
cannot be called from a service worker, **the agent loop structurally cannot
widen its own reach.** That is better than a policy saying it mustn't.

There are **no declared content scripts**. A declared content script needs
matching `host_permissions` at install, forcing the broad warning before the user
has granted a single site — the exact inversion of this model. Injection happens
on demand, into a tab whose origin was just granted.

## No new dependencies

This package deliberately has none. Chrome's API surface is declared by hand in
[`src/types/chrome.d.ts`](src/types/chrome.d.ts), covering only what we actually
call — which doubles as the justification list for the Web Store review.

`esbuild` is a root **devDependency**, not a dependency of this package: it
builds the bundle and ships none of itself. Nothing enters the CRX that is not
written here.
