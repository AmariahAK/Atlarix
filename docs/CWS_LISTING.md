# Chrome Web Store listing — Atlarix

The store copy for the extension, and how it gets to the store.

**Item:** `fkoacefbjjjhjceidagdajkgclfjacbe`, published. The id is pinned by the manifest `key`
in `packages/extension/manifest.json`, and used by `packages/extension/src/auth/redirect.ts`
and `src/lib/bridge/host-install.ts`. Publisher account: `amariah@atlarix.dev`.

**Where each field's text lives:**

| Dashboard tab             | Source                                                                      |
| ------------------------- | --------------------------------------------------------------------------- |
| Store listing → short and detailed description | this file (below); the detailed text is pasted from `cws/DESCRIPTION.txt`, which must match it |
| Privacy (single purpose, every permission, remote code, data use, host permission) | `cws/PRIVACY-FORM.md` |
| Access → Test instructions | `cws/TEST-INSTRUCTIONS.txt` (credentials go in the dashboard, not the file) |
| Screenshots and promo tiles | `cws/*.png`                                                               |

Run `node scripts/cws-copy-check.mjs` before pasting anything. It enforces the
1,000-character field limit and the line shape that got v1.0.0 rejected ("Spam and Placement
in the Store — excessive keywords", for a description line naming six file formats).

The Store API sets the PACKAGE and nothing else. Description, screenshots and
justifications are dashboard-only, so a green CI run never means the listing is current.

---

## What the extension does today

Checked against the code on 2026-09-23. Anything the listing claims should be on this list.

- **A side-panel agent.** The whole UI is the side panel (`side_panel` in the manifest); in a
  Chromium without `chrome.sidePanel` (Arc), the toolbar button opens the same page in a
  window. Opening the panel starts a new conversation.
- **Reads and acts on pages:** `read_page`, `find_on_page`, `click`, `fill`, `press_key`,
  `hover`, `scroll`, and `screenshot` (declined up front when the selected model cannot see
  images). Tabs: `list_tabs`, `open_tab`, `close_tab`; tabs it opens go into an "Atlarix" tab
  group, and it only closes tabs in that group. Tool list:
  `packages/extension/src/tools/schemas.ts`.
- **Asks per site in the panel.** The panel's agent asks the first time it touches a site
  (reading included); grants are listed and revocable from the panel and the account page. Password, payment,
  download and destructive actions always ask, whatever the site grant
  (`src/lib/browser/always-ask.ts`). Filling a form stops short of submitting unless the user
  asked it to submit (the agent prompt, `packages/extension/src/agent/prompt.ts`).
- **Pairs with the desktop app** over native messaging (`dev.atlarix.bridge`). Requests from
  the desktop run without a per-site prompt; host access is a REQUIRED permission for that
  reason, and users narrow it from chrome://extensions.
- **Attachments, relics and files.** Attach a document or spreadsheet and it reads the whole
  file on the device; `create_relic` builds a self-contained page opened in its own tab;
  `run_code` builds a file (CSV, workbook, PDF, image, zip) offered as a Download card. Relics
  and `run_code` execute only in the manifest's `sandbox` pages with `connect-src 'none'`.
- **Also:** `web_search`, notes (`remember` / `read_note` / `forget_note`), `recall` of earlier
  conversations, `ask_user`, and the account's MCP connectors (`list_available_mcps`,
  `mcp_call`).
- **Conversations sync** across devices as what was said (messages, replies, one-line tool
  labels, compaction summaries). Raw tool results, including page text, never sync
  (`packages/extension/src/sessions/sync.ts`).
- **Models: Atlarix Auto is the default** (`chooseModel`, `packages/extension/src/panel/model-choice.ts`).
  The extension is PAID-ONLY: Auto here is always the paid, private version (Pro allowance or
  credit), and the proxy never serves the extension from the free pool — free Auto is
  desktop-only. A no-credit account gets the credit-first line (`CREDIT_FIRST_LINE`: add credit from $10, or Pro). The extension is
  Core-only: there is no BYOK path in it. See [`CORE_BILLING.md`](./CORE_BILLING.md).

---

## Short description (132 characters max)

> An AI agent in a side panel that reads and acts on the pages you are already signed into.
> Pay as you go from $10, or Atlarix Pro.

---

## Detailed description

`cws/DESCRIPTION.txt` is what gets pasted; keep it identical to this block.

> Atlarix is an AI agent that works inside the browser you already use, with the sessions you
> are already signed into. Open the side panel, ask for something, and it reads the page,
> follows links, fills forms and pulls the answer together — without asking you to copy
> anything into a chat window.
>
> YOU DECIDE WHERE IT WORKS
> In the side panel, Atlarix asks the first time it touches a site, and every site it has
> worked on is listed and revocable from the panel or your account. Passwords, payments,
> downloads and anything destructive always stop and ask, whatever you have allowed.
> Atlarix also pairs with its own desktop app, and what you ask for there runs without a
> second prompt in the browser — you already asked for it in the app. You can narrow Atlarix
> to chosen sites from your browser's extensions page at any time.
>
> IT FILLS FORMS, AND LEAVES SUBMITTING TO YOU
> Unless you ask it to submit, it fills the form and stops.
>
> WHAT YOU CAN DO WITH IT
> • Read and summarise the page you are on, or a tab you have not opened yet
> • Work across several tabs at once — compare, cross-reference, collect
> • Let it click, type, scroll and take a screenshot to check what it sees
> • Attach a document or a spreadsheet and ask about it. Atlarix reads the whole file, not
>   the first page of it
> • Ask for a relic: a self-contained chart, table or calculator it builds for you and you
>   open in its own tab
> • Ask for the answer as a file instead of a message, and it writes one you can download
> • Pick a conversation back up on another device, because what was said follows your account
>
> WHAT SYNCS, AND WHAT DOES NOT
> Page text goes to the model to answer what you asked. It is never synced to your account:
> what syncs is what was said — your messages and its replies — so a conversation can be
> continued elsewhere. The files you attach stay on your device; only what the model reads
> from them is sent to it.
>
> Every tab Atlarix opens is collected into a labelled group, so you can see at a glance what
> it has touched.
>
> WHAT IT COSTS
> The side-panel agent runs on your Atlarix balance: add credit from $10 at atlarix.dev and pay only for what you use, with no subscription. Or get Atlarix Pro ($19/month), which includes Core usage across the desktop app, this extension and Reviewer. It runs on Atlarix Auto, which picks the right model for each step. You always see what a conversation is using in the panel, and Atlarix will not start a turn it cannot pay for.
>
> Read how we handle data at https://atlarix.dev/privacy and https://atlarix.dev/data-use

---

## Permissions

The manifest's list, for spotting a change. Each one's justification is in
`cws/PRIVACY-FORM.md`; a permission added to `manifest.json` needs its justification written
there and pasted by hand, and moves the next review onto the manual track.

`identity`, `storage`, `unlimitedStorage`, `sidePanel`, `tabs`, `scripting`, `tabGroups`,
`debugger`, `nativeMessaging`, `alarms`, and `host_permissions` `http://*/*` +
`https://*/*` (REQUIRED since 2026-09-17).

**`debugger` is used for more than input now.** It dispatches trusted keyboard and mouse
events (`Input.*`), records console and network activity in the agent's own tabs (`Runtime.*` /
`Network.*`, `packages/extension/src/page/cdp-capture.ts`, since v14.48.0), and captures
screenshots of the agent's own tabs (`Page.captureScreenshot`, since 2026-09-23), staying attached
for the life of such a tab. Any justification that says it is "never used to read network
traffic" or is attached "only for the duration of an action" is out of date; see the open
item in `docs/TODO.md`.

---

## Screenshots

1280×800 (preferred) or 640×400, up to five, from a clean profile with no personal tabs, one
theme throughout. `cws/fit-screenshot.py` fits a capture to size.

In `cws/` today: `screenshot-1-relic.png`, `screenshot-2-reading.png`,
`screenshot-3-permission.png`, `screenshot-4-attachment.png`, `screenshot-5-preview.png`, plus
the `promo-small-440x280.png` and `promo-marquee-1400x560.png` tiles.

None of them shows Atlarix Auto as the selected model, the agent acting on a page (click or
fill with the pointer and the green frame), or a screenshot in the conversation. Worth
retaking the reading shot with the model chip on Auto.

Avoid any real email address, signed-in personal account, or page with a name or balance on it.

---

## How a build reaches the store

- **Every desktop release** (`v*` tag): `release.yml` builds the extension and attaches
  `atlarix-extension-<version>.zip` to the release. It calls `.github/workflows/cws.yml` to
  upload and submit only when `scripts/extension-changed.mjs` says the bundle's inputs
  changed since the previous tag, and only while the `CWS_AUTO_SUBMIT` repo variable is
  `true`.
- **Between desktop releases:** push an `ext-v<version>` tag, which runs `cws.yml` directly.
  The extension's version is the app's (`scripts/sync-extension-version.mjs`).
- **Manual:** dispatch `cws.yml`. It defaults to `trustedTesters`, can upload a draft without
  submitting, and can stage a public rollout by percentage.
- Submission never gates a release, and a submitted review cannot be recalled.
- `cws-keepalive.yml` keeps the API refresh token alive.

Local build: `npm run build:extension` writes `packages/extension/dist/atlarix-extension-<version>.zip`.

**By hand, whenever the copy or permissions change:** paste the changed blocks from this file
and `cws/PRIVACY-FORM.md` into the dashboard, upload any new screenshots, and make sure the
review account named in the dashboard's test instructions still works (see
`cws/PRIVACY-FORM.md`, "Access → Test instructions").
