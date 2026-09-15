# Chrome Web Store submission — Atlarix

Everything the dashboard asks for, written out so it is composed here rather
than in a web form. Paste from this file.

**Account facts** (verified 2026-09-12): `amariah@atlarix.dev`, $5 one-time fee
paid, trader declaration filed, new publishers capped at 2 items. The draft item
already exists — its id is `fkoacefbjjjhjceidagdajkgclfjacbe`, which is pinned in
`packages/extension/manifest.json` and in `src/auth/redirect.ts`. This is an
UPDATE to that draft, not a new item.

---

## Blockers to clear first

1. **Publisher display name still reads `amariah`.** It appears on the public
   listing. Change it to **NorahLabs** in the developer dashboard's Account
   settings before anything is public. This is the one item that cannot be fixed
   after the fact without a visible edit.
2. **The trader declaration publishes a legal name, phone and address** at the
   bottom of the listing. Use NorahLabs' registered address, not a home one.
3. ~~Decide the version.~~ **DONE — `1.0.0`**, set in both
   `packages/extension/manifest.json` and `packages/extension/package.json`
   (the build asserts they agree).
4. **The extension work is on the `dev` branch.** Decide whether the submitted
   zip should be built from `main` first.
5. **Screenshots do not exist yet** — see the shot list below. This is the only
   item that needs the extension running in front of a human.

---

## Single purpose

> Atlarix is a browser agent: it reads and acts on the pages you are already
> signed into, in a side panel, so you can ask for something across sites you
> already have access to instead of copying and pasting between them.

---

## Short description (132 characters max)

> Ask Atlarix to read and act on the pages you are already signed into — in a
> side panel, on the sites you allow.

*(118 characters.)*

---

## Detailed description

> Atlarix is an AI agent that works inside the browser you already use, with the
> sessions you are already signed into. Open the side panel, ask for something,
> and it reads the page, follows links, fills forms and pulls the answer
> together — without asking you to copy anything into a chat window.
>
> **It works on the sites you allow, and only those.** Access is granted per
> site, by you, and can be revoked at any time from the panel or from your
> account. Atlarix never asks for access to every site you visit.
>
> **It fills forms but never submits them.** Anything that sends, buys, posts or
> deletes stops and asks you first.
>
> **What you can do with it**
> - Read and summarise the page you are on, or a tab you have not opened yet
> - Work across several tabs at once — compare, cross-reference, collect
> - Attach files and ask about them: text and code, images, PDFs, Word, Excel,
>   PowerPoint, OpenDocument and EPUB. Nothing is truncated; Atlarix reads as
>   much of a file as the question needs.
> - Ask for a relic — a self-contained chart, table or calculator it builds for
>   you and you open in its own tab
> - Pick up a conversation on another device, because what was said follows your
>   account
>
> **What stays on your device.** The contents of pages Atlarix reads never leave
> your machine, and neither do the files you attach. What syncs to your account
> is what was said — your messages and its replies — so a conversation can be
> continued elsewhere. Page content is not part of that.
>
> Atlarix requires an account. See atlarix.dev/privacy and atlarix.dev/data-use.

---

## Permission justifications

The dashboard asks for one per permission. Each of these is the real reason,
phrased for a reviewer who has not read the code.

**`identity`**
> Used solely for sign-in. Atlarix requires an account, and
> `chrome.identity.launchWebAuthFlow` runs the OAuth flow against our own
> authentication service. No contacts, profile or other identity data is read.

**`storage`**
> Conversations, the user's saved notes, their site-access grants and their
> model preference are kept locally so the panel survives being closed.

**`unlimitedStorage`**
> Files the user attaches are kept on the device rather than uploaded to a
> server, and are deliberately never truncated, so that the model can read a
> whole spreadsheet or log. The default 10 MB quota is shared with conversation
> history and a single large attachment exhausts it, which would silently stop
> conversations saving. Nothing is uploaded in exchange for this.

**`sidePanel`**
> The entire user interface is a side panel. There is no other surface.

**`tabs`**
> To read the title and URL of the tab the user is asking about, to open a tab
> when asked, and to keep the agent's own tabs in a labelled group separate from
> the user's. Browsing history is never read, stored or transmitted.

**`scripting`**
> To inject the reading and interaction scripts into a page the user has
> explicitly granted access to. Injection is gated on that per-site grant and
> happens nowhere else.

**`tabGroups`**
> Tabs the agent opens are collected into a group titled "Atlarix" so the user
> can see at a glance what it has touched, and closing that group stops the
> agent. It is the product's visible boundary and its stop gesture.

**`debugger`** — *expect this one to draw questions; answer it fully*
> Used only to dispatch trusted keyboard and mouse events to a page the user has
> granted access to. `chrome.debugger` is the only API in Chrome that can
> produce events with `isTrusted = true`, and untrusted synthetic events are
> silently ignored by the web platform for the two cases that matter most:
> Enter-to-submit on a form, and CSS `:hover` states that reveal menus. Without
> it the agent appears to click and nothing happens. It is attached only to a
> tab the user has granted, only for the duration of an action, and is never
> used to read network traffic or page memory.

**`host_permissions` (`<all_urls>`)**
> Atlarix is a browser agent and cannot know in advance which sites a user will
> ask about, so there is no set of origins that could be declared ahead of time
> without breaking the product for everyone whose work is not on that list.
> Holding the permission is not using it: the agent asks the first time it needs
> a site, one origin at a time, and reads or acts on nothing until the user has
> said yes. That list is shown in the panel and on the account page, and
> removing a site takes effect on the agent's very next action.
>
> **This field is new.** It did not exist while the patterns were
> `optional_host_permissions`, and broad host access draws the heaviest review
> scrutiny of anything on the form.

---

## Remote code

**Answer: Yes — and the justification matters.**

> Atlarix can build a "relic": a single self-contained HTML document, generated
> in response to the user's request, which the user opens by clicking. It is not
> fetched from a third party and it is not part of the extension's own logic.
>
> It executes only inside a page declared under the manifest's `sandbox` key,
> which Chrome loads into an opaque origin with no access to extension APIs, no
> same-origin handle back to the extension, and `postMessage` as its only
> channel. The sandbox's Content Security Policy additionally sets
> `connect-src 'none'`, `form-action 'none'`, `object-src 'none'` and a
> restricted `img-src`, so a relic has no network access of any kind and cannot
> exfiltrate anything.
>
> This is the pattern Chrome's own remote-hosted-code guidance names for exactly
> this case: code that must be executed but is not trusted belongs in a
> sandboxed iframe where "the Content Security Policy that blocks the usage of
> eval can be lifted". The extension's own pages remain under the default MV3
> policy with no `unsafe-eval` and no `unsafe-inline`, and no code outside the
> sandbox is ever fetched or evaluated at runtime.

---

## Data use disclosures

Tick, with the reason:

- **Personally identifiable information** — yes: an email address, for
  authentication only.
- **Authentication information** — yes: the session token for the user's own
  Atlarix account.
- **Website content** — yes, and be precise in the note: page content is sent to
  the language model to answer the question the user asked, and is not retained
  after the response. It is not stored on our servers, not used for training,
  and not synced between devices.
- **User activity** — no.
- **Personal communications, financial, health, location** — no.

Three certifications to accept: data is not sold to third parties; data is not
used for purposes unrelated to the single purpose; data is not used to determine
creditworthiness or for lending.

Privacy policy URL: `https://atlarix.dev/privacy`

---

## Screenshot shot list

1280×800 (preferred) or 640×400, at least one, up to five. Use a clean profile
with no personal tabs visible, and a light or dark theme consistently.

1. **The panel answering about a page** — the side panel open beside a real
   article, mid-answer, with an activity card visible. This is the product in
   one image and should be first.
2. **Per-site access** — the grant prompt or the site list, which is the
   strongest differentiator and the answer to "what can it see".
3. **An attachment** — a spreadsheet attached and a question about it, showing
   the chip in the transcript.
4. **A relic** — the relic tab open with a chart or calculator in it.
5. **Tab work** — the "Atlarix" tab group with two or three tabs it opened.

Avoid: any real email address, any signed-in personal account, any page with a
name or balance on it.

---

## Submission steps

1. Clear the blockers above — publisher name first.
2. `npm run build:extension` and take
   `packages/extension/dist/atlarix-extension-<version>.zip`.
3. Developer dashboard → the existing item → **Package** → Upload new package.
4. **Store listing** — paste the description, upload screenshots, set the
   category (Productivity / Workflow & Planning), language, and the privacy
   policy URL.
5. **Privacy practices** — paste the single purpose, every permission
   justification, the remote-code justification, and tick the data disclosures.
6. **Distribution** — **public**, decided 2026-09-14.
7. Submit for review. Expect days, not hours, and expect `debugger` to be the
   thing they ask about.

---

## Before pressing submit

One full pass on the built extension by a human, in the browser, because
everything shipped today was verified by unit tests and isolated probe pages:
attachments (including a real `.xlsx`), paging a large file, chip folding,
headings in an answer, a relic that opens, per-site grants, and sign-in.
