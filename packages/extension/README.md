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

## One contract, two backends

The model sees ONE tool surface (`browser` / `browser_inspect`, with a `target`).
That holds because both backends execute the *same* page-realm strings from
[`src/lib/browser/page-scripts`](../../src/lib/browser/page-scripts/index.ts) —
the walker, the `data-atlarix-ref` registry, the find ranker, the fill-target walk.
The in-app browser runs them through `executeJavaScript`; here they run in a
content script. Change ranking or ref semantics THERE, never here.

`src/__tests__/page-scripts-portable.test.ts` pins that module's zero-import rule,
because an `import` that is invisible on the desktop is fatal in a content script.

## No new dependencies

This package deliberately has none. Chrome's API surface is declared by hand in
[`src/types/chrome.d.ts`](src/types/chrome.d.ts), covering only what we actually
call — which doubles as the justification list for the Web Store review.
