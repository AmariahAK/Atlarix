# Chrome Web Store — Privacy tab

Paste each block into the matching field.

## Single purpose description

```
Atlarix is a browser agent. Its single purpose is to read and act on web pages on the user's behalf, in a side panel, using the sessions the user is already signed into — so they can ask a question about the sites they already have access to instead of copying content between them.

Everything the extension does serves that one purpose: reading the current page or a tab the user names, navigating and clicking within sites the user has granted, attaching the user's own files as context for a question, and presenting the answer in the panel.

Host access is NOT requested at install. It is declared as optional_host_permissions and requested one origin at a time, at the moment the user asks Atlarix to work on that site, behind Chrome's own permission prompt. The user can revoke any site from the panel or from their account page. The extension ships able to read nothing.
```

## identity

```
Sign-in only. Atlarix requires an account, and chrome.identity.launchWebAuthFlow is used to run an OAuth 2.0 authorization-code flow with PKCE against our own authentication service, returning to the extension's chromiumapp.org redirect URL.

We do not call getProfileUserInfo, do not read the user's Google profile, contacts or any other Google account data, and do not use this permission for anything except obtaining and refreshing the user's own Atlarix session token.
```

## storage

```
Local persistence of the user's own data so the panel survives being closed: their conversations, the notes they ask Atlarix to remember, which sites they have granted, their selected model tier, and files they attach.

The side panel is destroyed whenever it is closed, so without storage every conversation would be lost mid-task. Nothing here is written by or readable by a web page.
```

## unlimitedStorage

```
Files the user attaches are kept on their own device rather than uploaded to a server, and are deliberately never truncated, so the model can read a whole spreadsheet, log or document rather than the first part of one.

chrome.storage.local's default quota is about 10 MB and is shared with the user's conversation history. A single large attachment exhausts it, and the failure mode is silent: the write that saves the attachment is the same write that saves the conversation, so conversations simply stop being saved with no error the user can act on.

Nothing is uploaded or transmitted in exchange for this permission. It exists precisely so that attached files can stay local.
```

## sidePanel

```
The entire user interface is a side panel: the conversation, the composer, the model picker and the site-access controls. There is no popup and no options page.

The agent's work loop also runs in the panel document, because a service worker is terminated after 30 seconds of a streaming response and would kill a turn mid-sentence.
```

## tabs

```
To read the title and URL of the tab the user is asking about, so the panel can say which page it is working on; to open a tab when the user asks it to; and to keep the tabs Atlarix opens in a labelled group, separate from the user's own.

Used only for tabs the user has directed Atlarix to, or that Atlarix itself opened. We do not enumerate, store or transmit the user's browsing history, and we do not read tabs the user has not granted access to.
```

## scripting

```
To inject the page-reading and interaction scripts into a page the user has explicitly granted Atlarix access to — building a structured outline of the page's text and controls so the model can answer about it, and clicking or filling an element the user asked for.

Injection is gated on that per-site grant: chrome.permissions.contains() is checked for the origin before any script is injected, so a site the user has not allowed is never touched. No remotely fetched script is ever injected; the injected functions are part of the extension package.
```

## tabGroups

```
Every tab Atlarix opens is placed in a tab group titled "Atlarix", so the user can see at a glance which tabs belong to the agent and which are their own, and the group's title reports what it is doing.

It is also the stop gesture: closing the group ends the run. This is the product's visible boundary — without it the agent's tabs would be indistinguishable from the user's.
```

## debugger

```
Used only to dispatch trusted keyboard and mouse input to a page the user has explicitly granted Atlarix access to.

chrome.debugger (Input.dispatchKeyEvent / Input.dispatchMouseEvent) is the only API in Chrome that produces events with isTrusted = true. Synthetic events created any other way are ignored by the web platform for the two cases that matter most: pressing Enter to submit a form, and CSS :hover states that reveal menus and dropdowns. Without this permission the agent appears to click and type while nothing happens.

It is attached to a single granted tab, only for the duration of the action, and detached immediately afterwards. We do not use it to read network traffic, inspect memory, set breakpoints, evaluate script, or observe any tab the user has not granted.
```

## Remote code justification

```
Atlarix can build a "relic": one self-contained HTML document generated in response to the user's own request — a chart, a table or a small calculator — which the user opens by clicking. It is not fetched from a third party, and it is not part of the extension's own logic.

It executes only inside a page declared under the manifest's "sandbox" key. Chrome loads that page into an opaque origin with no access to extension APIs, no same-origin handle back to the extension, and postMessage as its only channel. The sandbox CSP additionally sets connect-src 'none', form-action 'none', object-src 'none' and a restricted img-src, so a relic has no network access of any kind.

This is the pattern Chrome's remote-hosted-code guidance names for untrusted code. The extension's own pages keep the default MV3 policy with no unsafe-eval and no unsafe-inline, and no script is fetched or evaluated outside the sandbox.
```

## Are you using remote code?

**Yes, I am using Remote code.**

Answering "no" would be inaccurate. A relic is JavaScript that is not in the
package and arrives at runtime, which is exactly the definition on the form.
Inaccurate disclosure is what gets an item pulled after it is live, which is a
worse outcome than a question during review — and the answer to that question
is written above.

## Data usage — what to tick

TICK these four:

- **Personally identifiable information** — an email address, for the account.
- **Authentication information** — the user's own Atlarix session token.
- **Web history** — this one is easy to miss and it is genuinely true. A tool's
  one-line label syncs to the account so a conversation can be read back on
  another device, and those labels name pages: `Read the Antikythera mechanism
  article`, `Looked for "pricing" in example.com`, `Opened docs.example.com`.
  That is a list of pages with titles and times. It is the agent's activity at
  the user's direction rather than passive browsing surveillance, but it meets
  the definition on the form, and under-disclosing is a policy violation while
  over-disclosing is not.
- **Website content** — page text is sent to the language model to answer the
  question the user asked.

LEAVE these unticked, and the reasoning if a reviewer asks:

- **Personal communications** — Atlarix does not target the user's messages. If
  the user grants access to a webmail site, that page's text is covered by
  "Website content", which is the category the form provides for it. This
  category is for items that handle messaging as their function.
- **User activity** — Atlarix DISPATCHES clicks and keystrokes; it does not
  record the user's. There is no click, scroll, mouse-position or keystroke
  logging of any kind.
- **Health**, **Financial and payment**, **Location** — never collected. Atlarix
  asks for no payment details in the extension, and reads no location API.

Certify all three: no selling or transferring to third parties, no use unrelated
to the single purpose, no creditworthiness or lending use. All three are true.

## Privacy policy URL

```
https://atlarix.dev/privacy
```

## What is NOT on this form

There is no justification field for `http://*/*` and `https://*/*`, because they
are declared as `optional_host_permissions` rather than `permissions`. That is
worth knowing rather than worrying about: the reason the field is absent is the
same reason the extension is defensible — it holds no host access at install and
asks per origin behind Chrome's own prompt. The single-purpose description says
so explicitly, which is the right place for it.

---

## Distribution → Payments

**Contains in-app purchases.**

Not a judgment call, and the reason is specific to the EXTENSION rather than the
product. The desktop app is genuinely free because you can bring your own key or
run a local model. The extension cannot: `core/client.ts` is Core-only by
design — "what makes this a paid product rather than a free client for someone
else's key."

And the $1 signup trial is gone: `20260908140000_remove_signup_trial_credit.sql`
dropped `claim_signup_credit()` outright on 2026-09-08, because Core's lineup
moved to models where $1 bought one or two turns rather than twenty. So a new
account's balance is ZERO and its first message returns a 402.

The "Free of charge" radio asserts the item "doesn't contain any functionality
to purchase additional goods, content, services or functionality". The whole
product depends on purchased Core credit. Ticking it would be inaccurate, and
inaccurate disclosure is what pulls a live item rather than merely delaying one.

## Access → Test instructions — DO NOT SKIP THIS

This is the most likely single cause of rejection for this extension, and the
rejection would not mention money.

The extension signs in with Google or GitHub OAuth only — there is no
email/password path in `auth/sign-in.ts`. So a reviewer signs in with their own
account, lands on a zero balance, sends one message and gets "Not enough credit
to start a turn." From the outside that is an extension that does not work.

BEFORE SUBMITTING:

1. Create a GitHub account for review — GitHub rather than Google, because a
   shared Google account signed into from Google's own review infrastructure
   frequently trips an "unusual activity" block, and the reviewer cannot clear
   it.
2. Sign into Atlarix once with it, from the extension, so the user row exists.
3. Fund it. In the Supabase SQL editor, as the service role:

       select public.credit_wallet_service(
         '<that user uuid>'::uuid, 2000, 'topup', 'cws-review-2026-09'
       );

   2000 = $20.00, which is roughly 20–40 turns on the current lineup. `p_ref` is
   unique per top-up — reuse the same ref and it no-ops as a duplicate, which is
   the intended behaviour, so change it if you need to add more.
4. Paste `cws/TEST-INSTRUCTIONS.txt` into the Test instructions tab with the
   credentials filled in.

Check the balance before submitting, and again if the review comes back — an
account that has run dry mid-review looks identical to a broken extension.
