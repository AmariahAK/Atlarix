# Chrome Web Store — Privacy tab

Paste each block into the matching field.

EVERY BLOCK HERE IS UNDER 1000 CHARACTERS, which is the field limit rather than
a house style. Found the hard way while preparing 1.1.0: the single-purpose
block had been sitting at about 1,125 characters, so whatever is in the
dashboard was NOT this file verbatim — it was trimmed at paste time and the trim
was never written back. A field that silently differs from the file claiming to
be its source is worse than having no file, because the next person edits the
file and believes they have changed the submission.

So: re-paste every block this commit touched, and measure before pasting. The
numbers are printed by `node scripts/cws-copy-check.mjs`.

## Single purpose description

```
Atlarix is a browser agent. Its single purpose is to read and act on web pages on the user's behalf, using the sessions they are already signed into, so they can ask about sites they already have access to instead of copying content between them.

All of it serves that purpose: reading the current page or a named tab, navigating and clicking, attaching the user's files as context, and answering in the panel.

It is driven two ways. In the side panel, the agent asks before working on a site it has not been allowed on; that list is visible and revocable from the panel and from the user's account page.

The other way is a separate Atlarix desktop app, which the user installs and connects over native messaging. Requests from it run without a per-site prompt in the browser — the user approved the action in that app, and asking again in a window they are not looking at is the same decision relocated, not a new one. Site access stays restrictable per site from chrome://extensions.
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
To inject the page-reading and interaction scripts into a page the user asked about — building a structured outline of the page's text and controls so the model can answer about it, and clicking or filling an element the user asked for.

Injection is checked against Chrome's own host access first: chrome.permissions.contains() runs for the origin before any script is injected, so a site the user has restricted from chrome://extensions is never touched. For requests made in the side panel, the extension's own per-site allow-list is checked as well, and the agent asks before a site it has not been allowed on. Requests from the connected Atlarix desktop app are not asked about again, for the reason given under Single purpose.

It also measures how a page renders — layout defects, colour contrast and layout shift — when the agent checks a page it built; for the contrast rules it injects axe-core, an open-source accessibility library shipped unmodified inside the package (vendor/axe.min.js).

No remotely fetched script is ever injected; the injected functions and files are part of the extension package.
```

## tabGroups

```
Every tab Atlarix opens is placed in a tab group titled "Atlarix", so the user can see at a glance which tabs belong to the agent and which are their own, and the group's title reports what it is doing.

It is also the stop gesture: closing the group ends the run. This is the product's visible boundary — without it the agent's tabs would be indistinguishable from the user's.
```

## debugger

```
Used only on tabs Atlarix itself opened — the tabs in its own "Atlarix" tab group. It refuses to attach to any tab the user opened.

On those tabs it does three things. It dispatches trusted keyboard and mouse input (Input.dispatchKeyEvent / dispatchMouseEvent): the only API that produces isTrusted events, without which Enter does not submit a form and :hover menus never open. It records the tab's console messages and network requests (Runtime and Network domains) from when the tab opens, and fetches one response's body on demand (Network.getResponseBody) when the agent asks about that request, so it can tell the user why a page failed. And it captures a screenshot of the tab (Page.captureScreenshot) when the user's task needs to see the page.

It stays attached while that agent tab is open, so Chrome shows its "started debugging" banner on it, and detaches when the tab closes or the run ends. We do not use it to inspect memory, set breakpoints, or evaluate script, and never on a tab the user opened.
```

## nativeMessaging

THESE TWO LIVED ONLY IN THE DASHBOARD until 2026-09-17, which is why the op list
below had gone stale and why this one claimed every page action was re-checked
against the user's per-site permissions — true when it was written, false once
the desktop path stopped asking. A field that is not in this file is a field
`cws-copy-check.mjs` cannot measure and nobody diffs.

```
Atlarix has a companion desktop app. This permission lets the extension talk to it, so the app can work in the browser the user is already signed into rather than a separate automated window.

One host only: dev.atlarix.bridge, a small relay shipped inside the desktop app. It makes no network connections — it passes messages between Chrome and a local socket on the same machine. Its manifest names this extension's ID as the only allowed origin. If the desktop app is not installed, the connection simply fails and the extension carries on.

The extension replies to a fixed, closed list of requests: list tabs, read the URL, read page text or structure, find an element, click, fill, scroll, press a key, hover, read the console or network activity, take a screenshot, navigate, open a tab, close a tab. Anything else is rejected.

Keystrokes, pointer moves, screenshots and console or network capture happen only in tabs Atlarix itself opened, never in the user's own.
```

## alarms

```
Used for one thing: retrying the connection to the companion desktop app.

That connection drops when the app quits or restarts, or was not running when the browser started. Reconnection uses short backoffs first, but a service worker is evicted after about 30 seconds idle and eviction destroys any pending setTimeout. Without an alarm, an extension that lost the connection while idle would never retry and the desktop app would look permanently disconnected.

One alarm, atlarix-bridge-reconnect, is created once the short backoffs are spent. It fires once a minute and does nothing but try the connection again, and is cleared as soon as one succeeds. There are no other alarms: it is not used for polling, network requests, keepalive or token refresh.
```

## Remote code justification

```
Atlarix generates code at the user's request. None of it is fetched from a third party or part of the extension's own logic.

Two features do this. A "relic" is one self-contained HTML document the user opens by clicking. The file feature runs JavaScript that builds a document the user asked for and returns bytes they save with a Download button.

Both execute only inside pages declared under the manifest's "sandbox" key, which Chrome loads in an opaque origin: no extension APIs, no same-origin handle back, postMessage as the only channel. The sandbox CSP sets connect-src 'none', object-src 'none' and form-action 'none', so neither has network access of any kind. The file feature's code runs in a worker created inside that sandboxed page, so it inherits the same opaque origin and the same connect-src 'none'.

The extension's own pages keep the default MV3 policy — no unsafe-eval, no unsafe-inline — and nothing is fetched or evaluated outside the sandbox.
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
- **Website content** — page text, and screenshots of Atlarix's own tabs, are
  sent to the language model to answer the question the user asked.

TRAINING — the extension is PAID-ONLY (owner decision 2026-09-23). It runs on
paid Atlarix Auto or a pinned Core model, never on free Auto, and the proxy
enforces that by surface. Nothing the extension sends is shared with a model
provider for training. (Free Atlarix Auto — shared with OpenAI — exists only in
the desktop app.) So the Limited Use certification holds without qualification.

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

## Host permission justification

HEADINGS MATCH THE DASHBOARD'S FIELD LABELS, not the manifest keys. This one was
`host_permissions (http://*/*, https://*/*)` for an afternoon and could not be
found by searching for the thing the form actually calls it. The dashboard is
the only place these are ever pasted; a heading that does not match its label is
a field nobody locates under pressure.

Covers `http://*/*` and `https://*/*`, REQUIRED as of 2026-09-17 — they were
`optional_host_permissions` before that. The reason is in Single purpose, and
the cost, Chrome's broad install warning, was taken deliberately.

```
Atlarix acts on whatever page the user asks about, and that set cannot be known in advance. The user names a site at the moment they ask — and, through the connected Atlarix desktop app, from outside the browser entirely, where no per-site prompt can be shown at all. A narrower declaration would mean the extension works on some of a user's sites and silently not others, with no way to tell which until it failed.

The access is used only to read the page the user asked about and perform the action they asked for. Nothing is fetched and injected from a remote source; the injected functions ship inside the package. Page content goes only to the model provider the user chose, in service of their own request.

It stays under the user's control: site access is restrictable per site from chrome://extensions, and the sites the agent has acted on are listed and revocable on their Atlarix account page.
```

---

## Distribution → Payments

**Contains in-app purchases.**

Not a judgment call, and the reason is specific to the EXTENSION rather than the
product. The desktop app is genuinely free because you can bring your own key or
run a local model. The extension cannot: `core/client.ts` is Core-only by
design — "what makes this a paid product rather than a free client for someone
else's key."

There is no signup credit (the $1 trial was dropped on 2026-09-08), and the
extension is paid-only: a new account with no credit gets a 402 and the upgrade
line (Pro or credit) on its first message.

The "Free of charge" radio asserts the item "doesn't contain any functionality
to purchase additional goods, content, services or functionality". Pro and
credit are exactly that. Ticking it would be inaccurate, and inaccurate
disclosure is what pulls a live item rather than merely delaying one.

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
