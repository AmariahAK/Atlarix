# Atlarix Changelog

> Entries are condensed to the shipped changes per version. Full prose, rationale, and
> file-level detail live in the git history.

## [15.10.0] (2026-10-21) — live sessions and /fork everywhere, safer approvals, and compaction that works

**Live sessions.** A session open in two places now stays in step. When the CLI, the app, VS Code or Zed is
running a turn, every other surface showing that session follows it as it happens: "Running in the CLI"
(or the app, or VS Code) with Stop. What you type there goes to the running turn, Stop stops it, and once it
ends your next message runs where you are, with the full history. `/undo`, `/compact` and a mode change say
why they wait instead of doing nothing. **`/fork`** copies a conversation into a new session, in the CLI, the
app (also in the session menu), VS Code and any editor that supports forking over ACP; the original is left
as it was, and `/undo` still restores files in the copy.

**Approvals.** After you answer a card, one line says what you allowed: "You approved Atlarix to always run
commands that start with `git` in this folder", in the CLI and in editors. A rule you save ("allow edits in
src/") now answers the cards it covers straight away, nothing runs twice, and editors take back a card a rule
already answered. "Always allow" in Explore and Plan saves the rule that is actually checked, so it takes.
The check for risky commands now reads git the way git does: `git reset -q --hard`, `git -c x=y reset --hard`,
`git -C dir …`, a command behind `timeout`, `xargs` or `env -S`, and a git alias defined inline all ask
first; read-only modes also see a commit hidden behind git's options or an environment variable.

**Compaction.** `/compact` counts what your tools returned, so a tool-heavy session is no longer "still
short"; it summarises with the session's own model, keeps what each turn found, and says so when a summary
fails. A request too long for the model is now compacted and retried instead of failing, and the answer
after it is saved.

**Several Atlarix at once.** Two processes on one machine no longer mix up sessions: an approval or a
background result can't land in another session, `/undo` snapshots never collide, temp files are cleaned
without touching another running Atlarix (an older version included), and the daily cleanup never removes a
session something still has open. A folder reached through a symlink is one workspace, and merging
duplicates keeps their automations, hooks and stats. Two surfaces starting at the same moment get a session each, and two Atlarix opening a new
profile together both start: before, one could fail and, retrying, delete the database the other was creating.
A CLI run on a profile of its own keeps its copy of Atlarix's built-in skills and helper programs inside that
profile, not in your `~/.atlarix`.

**MCP servers.** `/mcp` in the CLI now says whether each server actually connects: "✓ connected", or "✗ couldn't
connect" with the server's own reason ("Cannot find module …"), trying the ones not tried yet in the background.
A local server's error output no longer prints over the terminal. In the app, the server list follows a change
made in the CLI as soon as the window has focus again, the composer's server switches move at once and keep a
second click, an automation's tool is picked from the server's own tools, and a local server with no icon shows
its publisher's picture instead of a letter.

**Smaller fixes.** Web sources show as a list of links, never raw JSON, in the CLI and editors; the VS Code
panel has a copy button on code blocks and renders `[text](url)` links (as does the Chrome extension);
`/undo` to your first message renames the session; an Anthropic error is no longer reported as a PDF you
never attached; a turn uses its own model's output limit; the cost line prices Claude from the catalog (Fable
and the 5.5 models were missing or priced as 4.x); VS Code tells you when its configured CLI path can't run
instead of quietly using another; closing VS Code lets Atlarix clean up first; a turn stopped from another
surface before it showed anything ends as stopped in your editor, not as finished; deep thinking with no level
chosen (settings from before `/effort`, `atlarix run --deep-thinking`) asks for the model's highest level, where
Claude used to run at its default; `atlarix run --provider-id anthropic --provider-url …` goes to that address
(`--auth-header bearer` for one that takes a Bearer token) instead of Anthropic's; the prompt no longer lists
your machine's CPU cores and memory.

**Less load, better data.** The app reads your account on events, not on timers, and no longer fetches
account skills. Analytics send one complete event per turn (how it ended and why, mode and model changes,
approvals, compaction, sub-agents) and fewer, truer events overall; no error text, prompt or path is ever
sent, and VS Code's own telemetry switch is honoured. They also say what kind of provider and model a turn ran
on (a provider you added counts as "custom", never its name or address) and whether Atlarix Auto was free or
paid, and a key saved or a sign-in in the CLI is counted before the command exits. The CLI and editors now send
crash reports too, with home paths and emails removed. A turn that fails on your own key, a provider you added
or a local model is reported with the kind of failure, the provider type and the model, never the error's text;
a provider that keeps failing is reported as that, not as a dropped connection. **Signed-in accounts keep a daily
count of their turns**, by surface, provider type and model (never prompts, code or keys), as Atlarix already
did for Core and Auto: a few numbers sent at most every 15 minutes and when you quit, and off when VS Code's
telemetry is off. The consent question on every surface and the privacy page say so.

## [15.9.2] (2026-10-18) — a leaner prompt, and browser and DeepSeek fixes

**A leaner prompt on every turn.** Today's models need to be told what is true and what is
allowed, not walked through how to work, so the fixed part of each request is about a third
smaller: in Build, about 12,400 tokens where it was 18,400, with every tool still there.
Each rule is now stated once (plans, reviewing a sub-agent's work and the project rules
were each repeated two to four times), the coaching is gone, and the rules that fixed a
real mistake stay, shorter. Along the way: a mode is no longer told about tools it doesn't
have, notes meant for contributors are no longer sent to the model, and a model's name
reads "Sonnet 4.6", not "Sonnet 4 6".

**Browser:** reading a page's console right after opening it showed only what came after
the page finished loading, so anything the page logged while loading (a "ready" message, an
early error) was hidden. It now counts from when the page starts loading, with older
versions of the browser extension too. A tab number of 0 is treated as no tab rather than
refused, and closing a tab that is already gone reports it closed.

**DeepSeek through Amazon Bedrock:** a fragment of DeepSeek's own tool-call markup no longer
shows in replies, and replies saved before this read clean too.

## [15.9.1] (2026-10-18) — thinking on the newest Claude models, a fifth Core model, and web search in the terminal and editors

Thinking on Claude always went out as a token budget. Anthropic's newest models (Sonnet 5 and 5.5,
Opus 4.7 onwards, Haiku 5.5 and Fable) no longer take one and refuse the request, so with thinking
on, those models failed on your own Anthropic key, through Amazon Bedrock and through a gateway
alike. They now think adaptively, and `/effort` sets how hard, with the level the model lists sent
as it is; the thinking shows as a readable summary. Models that still take a budget (Haiku 4.5 and
older Opus) keep their three budget sizes. A Claude model reached through a provider you added on the
Anthropic format, under Bedrock's longer model id, also no longer gets a temperature it refuses.

**Core has room for a fifth model**, so the lineup can offer GPT-6 Luna beside GLM-5.3-Flash and the
three before them. Which models fill the slots still comes from the hosted lineup.

**Web search in the terminal and your editor runs through Atlarix** on a paid Core model or paid
Atlarix Auto, billed per search to your balance. There is no browser to search with there. The
desktop app keeps searching with its own built-in browser for everyone, which costs nothing, so a
paid model on the desktop no longer pays per search. When your balance can't cover a search and the
free fallback finds nothing either, the result now says so and points at `/billing`, instead of
reading as "nothing exists". Your own keys and free Auto keep the free search they had.

**A Core model this version doesn't know is refused, not swapped.** The app, the terminal and the
editors share their settings, so a model picked in a newer Atlarix could reach an older one, which
then answered on a different Core model, at that model's price. It now says the model comes from a
newer Atlarix: update, or pick another.

**The terminal's model list:** Atlarix Auto says "Free" only on a free account (Pro and credit pay
for it, so it shows its context size). Core models show their real context window, the same one the
context meter uses, not a 200K placeholder. The line under each reply names the model, not its
slot ("core-4").

**Microsoft Store:** a release now replaces a submission still in certification, so Store users get
the newest version without waiting for the one before it, and each submission explains to the
Store's testers why the app needs its two restricted permissions and how to try it.

## [15.9.0] (2026-10-17) — providers of your own on the Anthropic format, a prompt cache that lasts, and a faster CLI start

**A provider you add can speak the Anthropic Messages API**, not only OpenAI's: Amazon Bedrock's
Anthropic endpoint, a company gateway or proxy, any server that takes `/v1/messages`. Choose
**API format: OpenAI-compatible or Anthropic** when you add it, in the app (Settings → providers →
add a custom provider), the CLI (`/connect` → Other: your own endpoint), your editor and the VS Code
panel. The base URL is up to `/v1`, as before. Atlarix finds out which way the endpoint takes your
key (Anthropic's `x-api-key`, or a Bearer token, which Bedrock and many gateways use) and remembers
it; a key the endpoint refuses is never saved. Its models come from the endpoint's own list, or you
type the model id when it has none (Bedrock). Thinking, `/effort` levels and prompt caching work as
they do on Claude directly: a Bedrock model id such as `us.anthropic.claude-haiku-4-5-20251001-v1:0`
is recognised as the Claude model it is.

**Build mode keeps its prompt cache from one message to the next.** Each message's own text was
sent inside the part of the prompt the provider caches, so every message wrote the whole prompt
again instead of reading it. Now it follows the cached part. Measured on Claude: from the second
message on, about 18,800 tokens are read from the cache instead of written again, so the fixed
part of each message costs a small fraction of what it did. This applies to every provider that
caches.

**The CLI opens in a fraction of a second.** `atlarix` drew nothing for about two seconds after you
pressed enter: before its first frame it built every provider's model list, only to show the chosen
model's name in the header. It now remembers that name and draws at once (0.45 seconds where it was
2), then loads the list and corrects the name if it changed.

Also fixed:
- `/effort low` on a model that thinks with a budget (Claude, and Gemini and OpenRouter budgets)
  asked for the same budget as the default, and medium asked for more than the default; low is
  now smaller and medium is the default.
- Replacing a provider's key in the CLI or your editor checks it first, and a refused key leaves
  the old one in place.
- The CLI's test mode against a local model (`--provider-url`) takes `--provider-format anthropic`.

## [15.8.2] (2026-10-17) — a lighter start, and the whole MCP marketplace in the CLI and VS Code

The app checks your account once when it starts, instead of once per part of the screen that
shows it. Sign-in state used to be held separately by each part of the window (about two dozen),
each asking for it on its own and each showing its own "Signed in" toast; it is now held once and
shared. Your plan, subscription, ban and onboarding flags are read from the server in one request
instead of several, and the plan check that follows signing in reuses that read instead of
repeating it. Measured against the live server, a signed-in launch went from thirteen account
requests to two. Switching back to the window still checks your plan with the server every time,
so an upgrade still shows up at once; if the combined read fails, each value falls back to its own
lookup, so a paid account can never read as free.

The MCP marketplace in the CLI (`/mcp`, then b) and the VS Code panel now says how many servers
there are, or how many match your search, and lets you page through all of them: the CLI loads
more as you scroll toward the end, VS Code has Show more. They used to stop at the first 50 and 25
with no sign there was more. The Debug mode's instructions are a little shorter, with the same
rules.

## [15.8.1] (2026-10-17) — a proper welcome in the CLI

Signed out, `atlarix` now opens on a welcome screen with the two ways in: sign in with your
browser (GitHub, Google or email), or with a code (for SSH or a machine with no browser, offered first where there's no
display). Nothing opens until you choose, the screen shows each step of the sign-in, esc goes back,
and ctrl+c quits. Before, it printed a line and opened a browser by itself, which could look like
the CLI had hung.

## [15.8.0] (2026-10-17) — /effort: how hard the model thinks, on every model

**/effort** replaces deep thinking with one control for how hard the model thinks, in the app's
composer menu, the CLI (`/effort`, ctrl+t for the top level or back to the default), and your editor
(VS Code, Cursor, Zed and JetBrains, plus `/effort` in the chat). On your own key or a Core model it
offers the model's own levels, exactly as the model lists them — `xhigh` stays `xhigh`, `none` and
`minimal` appear where a model has them — and sends the one you pick unchanged. A model with only
on and off shows off · on; one that takes a thinking budget shows three sizes; one with no setting
shows nothing. The default is what the model ran before, and a model you switch to keeps your level
only when it lists it too. On paid Atlarix Auto the three levels choose the models: low uses the
small, fast models (still thinking hard), medium is today's Auto, and max is what deep thinking was.
Free Auto runs at one level.

Also fixed: a reply that ends by asking you a question keeps everything it wrote before the question
once you answer, on screen and for the model (it used to vanish, drafted commit messages and all). In
the CLI, a "finished" line for background work stays where it happened instead of piling up under
the reply, a long command no longer pushes the Yes / No choices off the screen (ctrl+o shows more),
and the tab title says `<!> needs you` when Atlarix is waiting on you. Choosing "none" or "off" now
really turns thinking off on OpenRouter and Claude models, and Gemini gets the level you pick.

## [15.7.1] (2026-10-15) — your activity, MCP defaults, more free Auto, and fixes

A stopped reply stays saved as stopped, in every mode, so after you reopen the chat the next
message (yours or a contributor's) is answered and the stopped request isn't re-run. An edited
file's card shows the real change even when the model sends an empty file field. Without Git
installed, the chat says Revert is off, instead of never offering it; and the Revert dialog takes
a fresh look at what it will keep each time it opens. Automations: the form says what's missing
before Create, and a Run now is labelled as yours, not as a scheduled run.

There's more free Atlarix Auto to go round: it can now answer from more free models. Because that
shares your prompts with more providers, Atlarix asks you once more before you use free Auto. The
ask is two short lines now, and VS Code, Zed and JetBrains can give it too (before, a free user
there was told to accept something that wasn't on screen).

Choose the MCP servers every workspace offers: star a server in the marketplace (or ask the AI) and
it shows up, ready to connect, in the chat menu of every workspace, new ones included.

In the Chrome extension, Atlarix now asks before every call to a connected service, so a web page
can never get the agent to act on your accounts without your yes. It only asks for a call that can
run: a tool the service doesn't have is sent back to the agent first.

**Your activity.** See how you use Atlarix on this computer: lifetime tokens, your busiest day and
longest chat, streaks, a year-long activity calendar, your favourite models and modes, and the
skills and MCP servers you use most. On the Account page in the app, in VS Code's Account panel,
and as `/stats` in the CLI and any ACP editor. It's stored only on this computer.

Also fixed: stopping a reply before it starts no longer saves the previous reply in its place, and
a stopped reply is marked as stopped (with Continue) right away, not only after you reopen the
chat, and a stopped reply stays stopped after you quit (the CLI's `-c` marks it too, and it isn't
re-run); switching workspace from the ⌘K search opens that workspace's own chat, so your next message
goes where the header says (and a workspace never opened in the app no longer hangs on "Loading
workspace…"); search results show a chat's words, not its tool markup; chats on free Auto get
proper titles; Connect on an MCP server that needs a key opens its marketplace entry; removing a server that's
on all your devices asks first; a whole-file rewrite's card in the CLI and your editor counts the
lines it replaced; the agent
finds files in folders like `.atlarix/` when asked for them; and after "Not now" in an editor,
sending again asks again.

Known issue: if an older Atlarix (15.7.0) runs on the same computer after this one, for example
the VS Code extension before it updates, it can reset your MCP defaults and ask for free Auto's
consent once more. From this version on, settings from newer versions are kept.

## [15.7.0] (2026-10-14) — MCP servers from the official MCP Registry, on every surface

**The marketplace is the official MCP Registry, with five Verified servers on top.** Settings → MCP
→ Marketplace searches every server published to registry.modelcontextprotocol.io. Sentry, Notion,
Supabase, Canva and Linear are Verified and add in one click with a browser sign-in. Every other card
shows who published it (`io.github.someone`), whether it runs on the web or on this computer, and its
icon. The catalog is synced in the background every hour and searched on your computer, so the
marketplace works when the registry is slow or down; a copy ships with the app for a first run with
no network. Only the latest version of each server is shown, and deprecated or deleted ones drop out.

**Web servers follow you everywhere.** A server at a public https address is saved to your account,
so the app, the CLI, your editor and the Chrome extension all have it. A command, or an address on
this computer or your network, stays on this computer for the folder, shared by the app, the CLI and
your editors. Up to 10 are on at a time, counting both; one more is added switched off and says so.

**Add your own: paste anything.** Paste a URL, a command, or the `mcpServers` block from Claude
Desktop, Cursor, VS Code or Zed (or import the file), and each server goes where it belongs: a URL is
checked for how it signs in (browser sign-in, a key, or nothing), a server that needs a key asks for
it. The same box is `/mcp` → `a` in the CLI (it also takes a config file's path) and Add in the editor
extension; `/mcp` → `b` and Browse search the marketplace there too.

**Your editor's own MCP servers work in Atlarix.** An ACP editor (Zed, JetBrains, Atlarix's VS Code
extension) passes the MCP servers you set up in it; Atlarix now connects them for that chat, stdio and
http, with the same per-tool approval as your other servers. In an editor without an Atlarix panel,
`/mcp` lists the Verified servers and `/mcp add` takes a URL, a command or a marketplace name.

**Atlarix finds the server a task needs and asks you to connect it.** When a question or task needs
a service you haven't connected, Atlarix searches the registry and puts a "Recommended for you" card
above the box (the app, the editor extension, the Chrome extension) or a Connect / Not now prompt (the
CLI, other ACP editors). Connect adds it, signs you in or takes its key, and Atlarix is told: it either
waited for your answer or is woken when you connect, like a finished background task. A server it
added, or one that is signed out, gets the same card. On the desktop and in editors the agent can also
turn servers on and off, and sign one out for you to reconnect. MCP tool rows name what they use
("Using Linear: list issues…", then "Linear · list issues" with its result).

**Every server shows its own logo:** in the marketplace, your server lists, the suggestion cards, the
chat's MCP rows and the automation form in the app; in the editor extension; on the Chrome extension's
card; and on atlarix.dev's Connectors. The box's settings menu now lists the Verified five, so you can
connect one or switch it on and off without leaving the chat.

**Revert keeps the work you did after the turn.** Going back to an earlier message restores the
files that turn changed, except ones you (or another session) changed since, and it names those
files before and after it runs. Files come back byte for byte whatever the folder's
`.gitattributes` say, and a turn you stopped records its end state too, so its revert is as safe.

**Automations can watch your account's MCP servers,** not only ones on this computer, from the app,
the CLI and the editor extension.

**Smaller fixes.** Messages from another Atlarix session read "from contributor". An MCP server's sign-in now opens from the CLI and from editors (the link went
nowhere without an app window). Turning a server on now respects the limit of 10, which only adding
one did. Servers reached by URL can send any headers a config gives them, stored encrypted.
`manage_mcp_server` puts a public https server on your account. Adding the same server twice says
it is already added, and re-importing a config skips what is already there. A command whose program
isn't installed is refused. A reply that quotes JSON in a sentence (e.g. `{"success":true,…}`) no
longer turns into an 'unknown' tool step with the JSON cut out. In the app, a reply woken by a finished automation
now starts by saying which automation woke it, as the CLI and editors already did.

## [15.6.0] (2026-10-14) — automations that wake the agent, every provider, and a CLI and editor that read like the app

**A finished automation wakes the agent.** An automation set to tell Atlarix now wakes one chat in
its folder when it finishes, in the app, the CLI, the editor extension or any ACP editor, and the
agent acts on the result (a failing test run it fixes, a passing one it reports). Each run is taken
by exactly one chat across every open Atlarix; a stopped chat is never re-woken. Automations have
their own page in the editor and over ACP (`/automations`), with Run now, on/off, and delete from
the row.

**Every provider, and its models, before you connect one.** Models & keys lists every provider
(A–Z, a page at a time) with how many models it offers, kept current from the models.dev catalog.
Open one to see its models before adding a key. Connect a provider that isn't on the list (any
OpenAI-compatible address, with or without a key); a local server such as Ollama lists its own
models and runs them at their real context window. Remove a key from Models & keys, the CLI
(`/connect`, `atlarix keys remove`) or any ACP editor; removing a provider you added removes its key
too. A provider that can't be reached says so ("Couldn't reach <name>: …"), with "Couldn't connect,
retrying in 2s (1/3)…" while it retries, instead of "Something went wrong".

**The CLI and the editor panel, reworked to read like the app.** New colours in both. Thoughts read
as what they were about and how long they took; tables, diagrams (Mermaid flowcharts) and code are
drawn; command, read and search rows say what happened. Sub-agents and background tasks show in the
editor as in the app, and the agent says what woke it. Plans: Plan mode saves a plan written in the
reply, the card shows each step whole, "Build it" appears where the plan turn ends, a stopped build
offers "Continue building", and a reopened chat keeps its plan. A message typed while Atlarix works
steers the turn (Enter) or queues (Tab), and is never lost, even when a request fails and is
retried. `/compact` writes a real summary. Messages from another of your Atlarix sessions are
labelled as a teammate's and are never undone with yours.

**The desktop app.** Every finished automation can wake a chat in its folder; a provider you
added lists its own models and needs no key when it has none; a refused key reads "Key rejected";
an unreachable provider is named and says what to check; the providers you set up come first.
Edits show the file's real diff, approved by hand or not; a reply's header names the model it ran
on, kept after a reopen; a message sent mid-turn shows where the agent took it; a command moved to
the background shows as running. /compact compacts, as in the CLI. Automations say their
schedules in words and what a run found. Plans: the chat's plan card has its Build button, the
Plan panel lists each file once (not the ones the plan won't touch), and Build switches the
session to Build. Narrow windows fold panels sensibly; the light theme's diffs are readable; the
"Move to Applications?" prompt says what it replaces and keeps it by default.

**Safety:** on Windows, PowerShell downloads and deletes (Invoke-WebRequest, Remove-Item and
friends) now always ask, like curl, wget and rm.

**Known issue:** if the CLI and the desktop app both ask the macOS keychain at the same moment, the
app waits at startup until the CLI's prompt is answered.

**Also:** the editor's sign-in page and Account view are redesigned, and Sign out signs you out;
the editor follows the reply until you scroll up; the plan shows under its step to read and correct; `atlarix --help` and `atlarix run --help` list the commands and quitting says how to resume; a sub-agent's progress shows its reply once, not repeated; a failed background command says why; Windows
paths, approvals and PowerShell errors read correctly in the CLI; free usage that's over says when
it resets.

## [15.5.0] (2026-10-11) — the editor extension, redesigned; your keys and MCP servers everywhere

**Atlarix in VS Code, Cursor, Kiro and Windsurf is rebuilt around how you work in it.** A bar across the top for a new chat, past chats, MCP servers,
your account and settings. A task card over the conversation with the chat's tokens, how many came
from cache, what it cost on your own keys, how full the context is, and the plan ticking off as it
is built. Edits arrive as cards with their diff in order (the old view compared line sets and lost
order and repeated lines); commands show their output; a turn that changed files ends in a
checkpoint with **Compare** (each file then against now, in the editor's diff, read from the turn's
snapshot) and **Restore** (back to before it). An approval waits above the message box with what it
will run or change and why it is risky, and the bar says "Needs you". `@` offers Problems, a
terminal selection, git changes, a commit, a folder, a URL or files; `/` lists commands and this
folder's skills; images paste and drop in; the open file is offered as context. Hover one of your
messages to go back to it and send it again (its files restored if you choose). Past chats has
search, every folder's chats, starring, rename and delete.

**Models & keys.** The model picker is grouped (favourites, recent, Atlarix, then one group per
provider), searchable, with ★ favourites shared with the terminal and a Normal/Deep thinking switch.
Settings › Models & keys lists every provider with its masked key and whether the key works, checked
with the provider itself (`src/lib/provider-key-check.ts`; the model fetchers fall back to the
catalog, so a revoked key used to look fine). A rejected key says so and offers Replace; its models
are hidden in the picker until it works. Each provider has a page with its models' prices, context
and what each can do; a key is checked before it is saved, and a rejected one is not saved. Switch a
provider off without losing its key. Add any OpenAI-compatible endpoint (its models are read from
it). **A different model for Plan**: plan with a stronger model, build with the chosen one (off by
default; shared with the terminal through `cli-state.json`). Saving or removing one provider's key
no longer drops the other providers' settings (`writeProviderKey`, `src/main/settings.ts`).

**MCP servers you already set up elsewhere are found.** Servers configured in Claude Code, Cursor,
VS Code, Kiro, Windsurf, Zed or Claude Desktop appear under "Found on this computer" in the app's MCP
page, the extension, and the terminal's `/mcp`, each with Add; in Zed and JetBrains, `/mcp` lists
them and `/mcp add <name>` adds one. Nothing is added without that step, and no value from their
environment or headers is shown (`src/lib/mcp/discover-external.ts`). Added servers join the folder's
list that the app, the CLI and every editor share. MCP sign-in pages now open from the editor.

**Zed and JetBrains.** `/keys` shows your own keys and whether each works; adding or replacing one
happens in a terminal with the new `atlarix keys add <provider>` (a hidden prompt, checked before it
is saved), so a key never passes through a chat. This folder's skills are `/` commands. The model
option is grouped by provider, with a Thinking option where the model has one. "Sign in from a
terminal" now completes after `atlarix login`.

**Auto-approve.** "Edit files in this folder without asking" (Settings › Auto-approve): a rule for
the whole folder; a narrower rule, a deny included, still wins, and deletes, renames and anything
outside the folder still ask. The rules remembered in a folder are listed in plain words with
Forget.

**Fixes.** "Open in an editor tab" moves the chat instead of leaving the side bar unable to follow
it. The sign-in menu item only shows while signed out. The subscription link in Account shows only
for Pro.

## [15.4.2] (2026-10-10) — the editor extension asks for a rating, once

After the fifth turn that finishes normally, the extension asks once — "Enjoying Atlarix? A rating
helps other developers find it." — with Rate Atlarix and Not now, and never again whichever is
picked (`packages/vscode/src/rating.ts`, counted in the extension's global state). Rate opens the
Marketplace review form in VS Code and the Open VSX page in Cursor, Kiro, Windsurf and VSCodium.
The Marketplace and Open VSX rank extensions by installs and ratings, so a new one with neither sorts
last whatever its listing says. The listing's categories are AI, Chat, Programming Languages and
Machine Learning; Debuggers is gone, since people browse it for debug adapters.

## [15.4.1] (2026-10-10) — the editor extension's listings

The extension's `package.json` (`packages/vscode/package.json`) names its repository
(github.com/AmariahAK/atlarix-releases) and declares `"pricing": "Free"`, so the VS Code
Marketplace and Open VSX listings show a Repository link and a Free badge. The repository link is
also what Open VSX needs to verify the `atlarix` namespace. No change to the app, the CLI or the
extension's behaviour.

## [15.4.0] (2026-10-10) — Atlarix for VS Code, Cursor and Kiro; meet Rix

**Atlarix has its own extension for VS Code and the editors built on it** — Cursor, Kiro,
Windsurf, VSCodium. It runs the CLI's own agent (`atlarix acp`, bundled in the extension, so there
is nothing else to install) and draws the chat in Atlarix's colours: Build, Explore, Plan, Debug
and Review in the message box; every model the picker offers, Auto, Core and your own keys alike;
edits opened in the editor's own side-by-side diff before they are written, with Yes and No in the
chat; command approvals; questions answered from a card; Plan mode's plan in a panel with **Build
it**; messages from your other Atlarix sessions as cards, read without waiting for a prompt; your
Chrome through the extension; the selection (⌘⌥L) and files (@) and images as context; past
chats for the folder; and an Account panel — plan, credit, this chat's usage, Get Pro, Add
credit, manage or cancel your subscription, sign out, connect a provider key, and this folder's
MCP servers on or off. Running out of free share or credit offers Add credit, Pro or your own key
on the message itself. One VSIX per platform ships with every release (Windows on ARM runs the
x64 agent); Open VSX publishing is in CI, the Marketplace is uploaded by hand for now.

**Move a chat between surfaces.** `/editor` in the CLI (or `/editor cursor`, `/editor kiro`…) and
the app's session menu → Open in your editor carry a chat into the extension
(`vscode://atlarix.atlarix/open`, `lib/peers/open-in-editor.ts`); a chat from another folder opens
that folder in a new window, which loads it. From the editor, ⋯ → Continue in the Atlarix app or
in the terminal (`atlarix --resume` in the editor's terminal). Tips on every surface teach them.

**Plans tick off while they're built.** The plan stays on screen through Build in the extension
and in Zed's plan list (it used to vanish the moment Build started): ☐ ◐ ☑ per step, "Building…"
then "Built"; the panel folds, and "Whole plan" appears only when it says more than the steps.

**Zed and JetBrains get more from ACP too.** Building a plan switches the editor's mode picker to
Build (it stayed on Plan), plans arrive as the editor's own plan list, `/status`, `/billing`,
`/mcp` and `/logout` answer in the chat, and `/handoff` continues in the app. A reopened chat
shows its title. A session that cannot start says why — an
older Atlarix desktop app guarding the database, say — instead of "Internal error", and reopening
a chat the same editor already had open replays it in full.

**Rix, the Atlarix ant.** A weaver ant whose body is a turning globe and whose antenna is a
compass needle. He heads the CLI — a left-aligned header (version, model, mode, plan, folder)
that scrolls away with the conversation instead of a centred splash — and appears in the app's
and the extensions' empty chats, the site's hero and 404, and the videos. One source
(`src/lib/rix/rix-svg.ts`, exported to `assets/rix/` by `scripts/export-rix.ts`), with rest,
working, found, loading and scout states.

**Session recap.** Come back to a session after a few minutes away and one line says where it
stands — in the CLI (`◷ While you were away`, `/recap` any time, `/recap on|off`), the app (a card
under the conversation; Settings → Notifications), the Chrome panel and the editors. It is written
while you're away, on the session's own model and route, never saved and never sent back to the
model, and skipped on free Auto when the day's share is nearly gone (`lib/recap`).

**Usage analytics include an approximate location** for people who opted in: country and city,
worked out by PostHog from the connection; the IP address itself is discarded. posthog-node had
GeoIP off by default and the app blanked the address, so no event ever had a country. The consent
text in the first-run dialog, Settings, the CLI and the privacy policy says so.

**Smaller.** In the Chrome panel a message from another session is a step on the agent's side,
not a full-width card that read as an exchange. Checklists in the Chrome and VS Code chats draw as
☐ and ☑.

**Fixes.** Thinking and replies stream into editors and the CLI as they're written; before, they
arrived only when the turn ended, because main runs in the CLI's process and the session held
main's own live message, so every patch read as "no change" (`src/cli/agent/session.ts`). The
extension shows a thought open while the model thinks and folds it when the answer starts. An
answer that is only a number, date or time ("18", "3.14") no longer vanishes as tool debris
(`src/lib/chat/answer-display.ts`). A provider that refuses the request outright — a revoked API
key, no access to the model — is no longer retried twice and then reported as "Something went
wrong": the turn ends on the real reason (`turn-runner/round-retry.ts`, `simple-stream-text.ts`,
`finalize.ts`). Clicking Sign in again in the extension reopens the sign-in already under way
instead of starting another.

## [15.3.0] (2026-10-09) — Atlarix in your editor

**Atlarix runs inside Zed, JetBrains IDEs and VS Code.** The CLI is now also an
[Agent Client Protocol](https://agentclientprotocol.com) agent: `atlarix acp`. The editor draws
the chat, the diffs and the Allow/Deny prompts in its own UI, and Atlarix does the work with your
account, models, settings and chats, the same as the app and the terminal. Zed: add
`"agent_servers": { "Atlarix": { "type": "custom", "command": "atlarix", "args": ["acp"] } }`;
JetBrains: AI Assistant → Agents → Add Custom Agent with the same command; VS Code: through the
ACP Client extension. In the editor you get Build, Explore, Plan, Debug and Review as modes, every
model the picker offers, earlier sessions to reopen, cancel, and Atlarix's questions answered in
the chat. Every edit and command still waits for your OK, shown inside the tool call it belongs
to; a prompt outside a tool call offers Yes once or No only, never a standing rule. An editor's
session joins the others as "(editor)", so it can hand a browser task to Chrome and get the result
back. Under it: `src/cli/acp/` on `@agentclientprotocol/sdk`, a stdout that carries nothing but
the protocol, and the CLI's stand-in window now reaching every open session.

**Fixes.** Typing fast in the app's composer could throw "Maximum update depth exceeded": the
`@`-mention autocomplete set state on every key, and React 19 counted the leftover renders as
nested updates. A plain keystroke now renders the composer once. Starting a session no longer
reuses or prunes an empty session that another Atlarix window or editor thread has open (two
threads opened back to back used to share one session).

## [15.2.0] (2026-10-08) — the browser joins the conversation, and free limits that let people stay

**The Chrome extension is a session too.** `list_sessions` in the app and the CLI now shows the
Atlarix extension's agent ("Chrome", "Brave" or "Edge"), and `send_message` hands it a browser
task: "list this release on a launch site", "draft these emails". The toolbar icon shows a badge;
clicking it opens the side panel on the task, where you can steer it ("shorter, less salesy")
while your coding session keeps going. Its result comes back to the sender as "Message from
Chrome (browser)". It works the other way too: the extension's agent can list your CLI and app
sessions and send one work ("send this to my CLI"); a message to a session that did not ask
waits for your OK in the panel, every time, so a web page cannot steer it into messaging your
terminal. Under it: bridge protocol 2 (`lib/bridge/server.ts`: the extension may start one kind
of request, `ext-request`, only after a protocol-2 hello carrying a profile id),
`lib/peers/chrome-peer.ts` (the process hosting the browser registers it as a session and writes
the `from` on everything it sends), and in the extension an inbox (`peers/inbox.ts`), a narrow
service-worker router, and `list_sessions` / `send_message` tools. A message from another session
is never your approval; the extension still stops before any final submit. A handed-off task
syncs to your account only as its header line.

**Free Atlarix Auto lets new people keep going.** A turn averages about 180K tokens, so the free
day's 2M hard stop was about eleven messages, and the people who hit it did so on their first or
second day. New accounts now get double on that stop for their first week (the fallback model
it covers costs Atlarix nothing). When the free share is spent and the slower fallback model
answers, the composer now says "Auto · Free, slower model" instead of "0%".

**Pay-as-you-go comes first.** At the free limit the card offers Add credit, Use your own key,
then Upgrade to Pro, and the message names credit from $10 and your own key before the $19
plan. The extension's out-of-credit message and links lead with credit too ("Add credit at
atlarix.dev/account · Pro at atlarix.dev/pricing"); it used to read as "subscribe to use".

**Smaller fixes.** A message from another session over 20,000 characters lost its closing tag in
the queue and stopped reading as a peer's message.

## [15.1.0] (2026-10-07) — the agent sees images, sessions talk to each other

**The agent can look at images, video and audio.** `view_image` shows the model an image file
it made or found (a screenshot, a chart, frames it pulled out of a video), and `transcribe_audio`
turns an audio file into text. Both work in the app and the CLI, on your own key and on
Atlarix Auto, which moves to a model that can see when an image arrives. The tools say what
they take and nothing about how to get there: a live Auto run worked out frames-from-video on
its own. `read_file` on an image now points at `view_image` instead of returning bytes.

**Sessions message each other.** `list_sessions` and `send_message` let a CLI session and an app
session (or two of either) hand work back and forth on the same machine. A message shows as
"Message from <session>": a card on the agent's side in the app, a tool line in the CLI. It
never looks like something you typed. An idle session wakes to answer. `/handoff` continues a CLI
session in the app, and "Continue in terminal" opens an app session in the CLI
(`atlarix --resume <id>`). Settings → Notifications → "Messages from other sessions" turns it off.

**Paid web search.** On paid Atlarix Auto or Core, `web_search` asks Atlarix's own search first
(billed per search, plus tokens) and falls back to the free tiers; cloud runs keep the web tools.
The Chrome extension does the same.

**The desktop app holds its memory on long turns.** A stream used to resend the whole
conversation on every token: 46.5 MB over IPC for one long Build turn, 1.9 MB now. Command
output is bounded, older tool cards collapse, and the right panel no longer covers the chat.

**Smaller fixes.** No temperature is sent to OpenAI reasoning models, and the SDK's "not
supported" notices go to the log instead of a CLI toast. A command may write the agent's own
scratch folder without asking. A model on your own machine (Ollama, LM Studio, any loopback
URL) needs no API key: `atlarix --provider-url http://localhost:11434/v1` used to fall back to
Atlarix Core. `atlarix --attach <file>` sends files with a scripted task. `atlarix` is published
to npm only after its seven platform packages, so a fresh install never finds no binary.

## [15.0.1] (2026-10-05) — sub-agents in the terminal, coloured code, and a readable plan

**Sub-agents work in the terminal.** Every sub-agent the CLI started failed with
"BrowserWindow.fromWebContents is not a function" and then showed as running forever. They run
now, on the session's own model: a sub-agent used to take the app's saved model (or Auto)
instead of the one the CLI session was using. A sub-agent that fails to start is marked as
finished.

**The CLI carries its own prompts.** The mode prompts (Build, Plan, Ask, Debug, Review), the
sub-agent prompts and the guides were read from `src/skills` in the folder you ran it in, which
only exists inside Atlarix's own repository. Everywhere else every turn went without its mode
prompt, silently, and every sub-agent failed on `src/skills/subagents/subagent.md`. They are
inside the binary now (unpacked once to `~/.atlarix/skills`), and the headless build ships them
beside its bundle.

**Sub-agents and background work sit under the prompt box.** "main" and what it is doing, then
one row per sub-agent with what it is doing now, how long it has run and its tokens; finished
ones drop off and background commands share one row. ↓ picks a row and enter opens that
sub-agent's own view, live: its tool calls and what it has written. ← → step between
sub-agents, esc backs out.

**The plan is pinned above the box while it waits to be built.** You read it while you decide,
type what to change below it, and it redraws as Atlarix revises it. "Build it" (or `/build`)
builds it; esc hides it and `/plan` brings it back. This replaces a "Plan ready" popup that
covered the conversation with the plan out of sight. The plan's "share" is now "save as page",
and says what it saved and where.

**Code is coloured.** Fenced code and edit diffs are syntax highlighted, and ```` ```ts ````,
```` ```py ```` and other short tags are recognised. A language's grammar is found by its name
the first time it shows up, preferring one already on your machine (shared with other terminal
apps built on the same toolkit), and only the languages you read are downloaded; offline, code
stays plain. Inline code is lavender instead of a dim grey chip.

**Sending is instant.** The first message of a session froze the terminal for about a second
before it appeared: token counting rebuilt its tokenizer on every call (56 times per first
turn). It is built once now, which also speeds up the app.

**The prompt box and its borders.** The box sits a step above the page. Its top border shows how
full the context is as a share and as tokens of the window (`context 23% · 47k/205k`); the
session's running total, which passed the window and read as a contradiction, is in `/status`.
A long session name ends in "…", and the hints fit the width.

**Smaller things.** The approval dialog's diff is syntax coloured like the transcript's, and
"Build it" no longer wraps on a narrow terminal. A message sent while a turn runs is drawn where the agent read it, between
the steps before it and the answer that took it in; it used to land below the whole reply, under
a footer that made the turn look finished. `/compact` and other conversation commands typed while a turn runs wait for
it to end, and messages typed after them still go in first (ctrl+s runs the command now).
Pasting the same text again opens a `[Pasted text]` chip into the full text, to edit. Checklists
read "☑ step" on one line. Plan and background-job tool lines say what they did instead of a bare
"◇ Plan", and a cut-off result never shows as raw JSON. Nothing is printed on your screen
before the CLI starts, so quitting leaves your shell clean. Several parallel calls that read
your balance share one request.

**An optional rating.** With usage analytics on, a long session may ask once "How is Atlarix
doing this session?" (1–3, or 0 to dismiss), at most once a week. It sends only the rating, the
mode, the model and the session length — never your prompts or code, and it is not used for
training.

**Also in this release:** markdown in the CLI is drawn directly (no flicker between formatted
text and raw `###`, no line drawn over the next, tables that fit); no stray characters when the
CLI starts in Terminal.app; the tab pulses while Atlarix works and says "needs you" when it waits
for you; Atlarix checks which build files your project has instead of assuming `package.json`;
and `npm i -g atlarix` installs two packages instead of forty.

## [15.0.0] (2026-10-03) — Atlarix in your terminal, the cloud agent, and email sign-in

**Atlarix runs in your terminal.** The same agent as the app, with the same sessions, keys,
models, MCP servers and automations: `atlarix` opens it in any folder. Install it with
`curl -fsSL https://atlarix.dev/install | sh` (macOS, Linux), `irm https://atlarix.dev/install.ps1 | iex`
(Windows), `brew install amariahak/atlarix/atlarix`, `npm i -g atlarix`, or winget. It updates
itself quietly. Sign in from the browser, or with `atlarix login --device` from a machine
without one.

**Relics: pages Atlarix makes to share.** Ask for a report, a plan or a design as a relic. On a
paid Atlarix model it gets a private atlarix.dev link you can share; otherwise it is saved in
the workspace. The app lists them in a new Relics tab; the terminal in `/relics`.

**You can sign in with an email and password.** For anyone who can't or won't use Google,
GitHub or Discord. Choose "Continue with email" in the app or the extension; the form opens on
atlarix.dev, where a Cloudflare Turnstile check stops scripted sign-ups, and you land back
signed in. New accounts confirm their address first; a forgotten password resets from the same
form.

**Atlarix can work on a repository while your computer is off.** Ask from Slack
(`owner/repo: fix the flaky login test`) or from atlarix.dev/cloud. Atlarix runs in that
repository's own GitHub Actions, opens a pull request, and posts it back with an **Approve &
merge** button. Nothing merges until the person who asked approves it, and your existing deploy
pipeline takes over from the merge. Model usage is billed to your balance; the runner is your
Actions minutes.

### Added
- **A Relics tab in the app** (right panel, beside Automations): every relic in one list, your hosted ones and this workspace's local ones, newest first. Open, copy the link, preview a local one, share or make private, delete. The same logic as the terminal's `/relics` (`src/lib/relics/relic-store.ts`).
- **Usage analytics count your own key and local models** (only if you opted in): one `model_turn` event per agent turn says who pays for the model (Atlarix Core, your own key, or local) and which provider and model, never content. Usage used to be read from paid Core alone, so people on their own keys looked like they had stopped.
- **Terminal: what runs in the background is in plain sight.** Above the prompt box, each background command and sub-agent: what it is, how long it has run, and what the sub-agent is doing now. ↓ still opens the list to follow or stop one.
- **Terminal: notifications.** When a turn ends, or Atlarix needs your OK or an answer, while the terminal isn't the window you're in, it sends a system notification (iTerm2, Ghostty, WezTerm, kitty, Windows Terminal) and rings the bell. `/notifications` turns them off.
- **Terminal: a backslash then enter adds a line, in any terminal.** Apple's Terminal sends shift+enter as a plain enter, so it sent the message; ctrl+j works there too.
- **Terminal: ctrl+o is a detail view.** It opens every thought, output and diff in full on a screen of its own (ctrl+o or esc goes back), instead of expanding everything in place. Collapsed items say "(ctrl+o)" only where there is more.
- **Terminal: pick background work from the strip.** ↓ selects a running command or sub-agent; enter opens its details (Status, Runtime, the command and its output, or the sub-agent's tool calls), updating live; x stops it.
- **Terminal: `/rename`** names the session; its name shows in the prompt box's border.
- **Terminal: commands stand out.** A `/command` and the `!` of a shell command are coloured as you type them; a command you ran with `!` shows as a band like your messages. A blank line now sits between the reply and the prompt box.
- **Terminal: a failed command is one line**, its error and the exit code, like a thought; ctrl+o shows the full output.
- **Terminal: file names stand out in tool lines.** "Edit src/cli/tui/**App.tsx**": the folder dim, the file name bold.
- **Terminal: a pasted text shows in your message after you send it**, the first lines with ctrl+o for the rest, instead of only "[Pasted text #1 +32 lines]".

- **Email + password sign-in** on the desktop app, the extension and atlarix.dev, protected by
  Turnstile. The app and extension hand off to atlarix.dev and check a one-time `state` on the
  way back.
- **The cloud agent**: a separate "Atlarix Agent" GitHub App, a one-click setup pull request
  that adds `.github/workflows/atlarix.yml`, the `atlarix` CLI running in the user's runner with
  a job-scoped Core token, and a Slack app for asking and approving. Paid from the wallet only;
  free Atlarix Auto never serves a cloud run.
- **In the `atlarix` CLI: `/model`, `@` and `!`.** `/model` picks from every model you can use,
  searchable, with favourites (`ctrl+f`) and recents, like opencode's picker; the choice is the
  CLI's own and does not change the desktop app's. `ctrl+t` turns deep thinking on and off. `@`
  completes a file or folder from the project. `!command` runs a command yourself, in the
  project, and Atlarix sees the command and its output with your next message.
- **Copy on select in the `atlarix` CLI**, like Claude Code: drag over any text and it is on
  your clipboard when you let go ("copied N chars to clipboard"). It goes through the terminal
  (OSC 52, which also works over SSH) and, on your own machine, the system copy tool, so it
  works in macOS Terminal too.
- **The `atlarix` CLI's commands.** `/resume` (any earlier session in the folder, the app's too;
  `atlarix -c` continues the newest, `atlarix --resume` opens the list), `/compact`, `/plan`,
  `/undo`, `/export` (Markdown or `--json`, `--sanitize` for sharing), `/import` (an export, or
  `--from claude|codex|opencode` for this folder's sessions in those tools), `/agents`,
  `/automations`, `/mcp`, `/permissions`, `/connect` (your own API key, shared with the app),
  `/status`, `/login` and `/logout`.
- **Plan mode ends with a choice in the CLI**: when a plan is ready, Build it, Keep planning, or
  view it.
- **Plans outlive their session.** `/plan` in the CLI and the app's Plan panel also list the
  folder's plans from earlier sessions; "Use in this session" (`b` in the CLI) copies one in and
  builds it.
- **Go back to an earlier message in the CLI**: `/undo` (or esc esc to choose which), optionally
  restoring the files changed since, then edit it and send — as editing a message does in the app.
- **Automations run in the CLI too**, and are made, edited, run and turned on or off there. They run
  while Atlarix (the app or the CLI) is open; with both open, each run still happens once.
- **The CLI and the app share your Chrome.** Whichever starts first connects to the extension; the
  other uses the browser through it, and takes over when the first quits.
- **The CLI asks you what the agent asks**: questions, MCP tool permissions, and the one-time OK for
  free Atlarix Auto, which now appears in `/model`.
- **Relics: pages Atlarix makes for you to share.** Ask for a design to agree on before building, an
  explainer or a report, and Atlarix makes it as a page and updates it as it changes. On paid Atlarix
  Core it is hosted privately at an atlarix.dev link you can share when you choose, with Share, Copy
  link and live updates. On your own API keys or free Atlarix Auto it is saved in your project
  (`.atlarix/relics/`) to open or send. The CLI lists them with `/relics` and `ctrl+]` opens the latest;
  `/plan share` shares a plan this way. In the app a relic appears as a card in the chat.
- **Install the CLI anywhere:** `curl -fsSL https://atlarix.dev/install | sh`, `irm
  https://atlarix.dev/install.ps1 | iex` on Windows, `brew install amariahak/atlarix/atlarix`,
  `npm install -g atlarix`, winget, or the .deb/.rpm packages. One self-contained program per
  platform (macOS, Linux including Alpine, Windows), checked against the release's checksums.
- **The CLI searches the web through your Chrome**, with the Atlarix extension. Without it, a search
  MCP server works.
- **The app and the CLI each get their own tab group in Chrome** ("Atlarix" and "Atlarix CLI"), so
  neither touches the other's tabs.
- **Sub-agents' work shows under them in the CLI**: each sub-agent's tool calls, nested under the
  task that started it, with what it is doing now and its result.
- **`atlarix login --device`** for machines with no browser (SSH, servers). Sign in on any
  device at atlarix.dev/auth/cli and type the code the terminal shows. It is the default over
  SSH. The session travels encrypted to a key only that terminal holds.
- **`--api-key-file`** on the `atlarix` CLI: run on your own provider key, read from a file that is then deleted. The key stays in memory, never written to settings or put in the environment, so the agent's commands can't see it. Atlarix Cloud's own-key runs use this.
- **Atlarix Cloud runs choose their model:** paid Atlarix Auto (the default), any paid Core model, or your own API key (free). Never free Atlarix Auto.
- **`--core-token-file`** on the `atlarix` CLI: run on Atlarix Core with a token read from a file
  and deleted, never placed in the environment.
- **The terminal app reads like a conversation.**
  - Your messages sit on a shaded band.
  - Thinking is one dim line ending in "…".
  - Each tool call is one line, with a one-line result under it.
  - Charts, graphs and mind maps show as bars, edges and outlines instead of raw JSON.
  - ctrl+o expands everything.
  - Mode, model and usage moved into the prompt box's top border, and the folder and key hints into its bottom border.
- **All five modes in the terminal app:** Build, Explore, Plan, Debug and Review. shift+tab cycles them; `/mode` picks one.
- **`/model` shows where your own keys go.** Its last row, "Add your own API key…", opens `/connect`.
- **`/exit`** leaves, like `/quit`.
- **Background work is visible in the terminal app.**
  - The prompt box's border counts what's running ("2 agents · 1 command").
  - ↓ in an empty box, or `/tasks`, lists the running sub-agents and background commands.
  - Enter follows one live: a sub-agent's tool calls as the app's card shows them, and the latest output.
  - k stops one.
- **The bottom border shows the keys that work right now.** While Atlarix works, that's stop, steer, queue, edit queued and tasks.
- **When the agent asks several questions,** you review all the answers before they go back, and can change any of them.
- **`/btw`** answers a side question about the conversation without interrupting the turn. Nothing is saved, and the agent doesn't see it.
- **Tips in the terminal app,** written for its keys and commands: one per turn under the working line, and one on the welcome screen.
- **`/billing` (or `/upgrade`) in the terminal app:** shows your Core credit and offers Pro ($19/month), credit to pay as you go ($10, $25, $50 or another amount) and managing the subscription. Checkout opens in the browser, and the link is shown for SSH sessions.
- **Running out says so, with the way out.**
  - When the free share is used up (with the reset time on your clock), or Core credit runs out (with what the turn needs), the terminal app shows what happened and what to do next.
  - Your own key is told apart by what the provider said: out of credit or over quota, rate-limited, or a rejected key. This used to read "This model failed (…)" in the app too.
- **`/undo` lets you choose which message to go back to**, like esc esc, newest first.
- **Usage analytics in the terminal app, with the app's consent.**
  - The app's "Help improve Atlarix" question is asked once if it has never been answered, using the same setting, so one answer covers both.
  - `/analytics` changes the answer later.
  - Events say they came from the terminal app, and a command is counted by its name only.
- **New lines in the prompt box:** shift+enter (in terminals that report it: Ghostty, kitty, WezTerm, iTerm2), option+enter, or ctrl+j (works everywhere).
- **The terminal app updates itself.**
  - It checks once a day in the background and installs a new version the way it was installed (install script, Homebrew or npm).
  - The install-script way checks the SHA-256 like the script does.
  - Then "✓ Update installed · restart to use vX" stays above the prompt box.
  - `ATLARIX_DISABLE_AUTOUPDATE=1` turns it off.
- **Popups are centred over the dimmed screen:** `/model`, `/connect`, `/mcp`, `/resume`, `/tasks` and the rest. Each footer says what its keys do. Short messages appear as toasts in the top-right corner.
- **`/model` is laid out like the app's picker.**
  - Favourites, then Recent, then each provider, with each model listed once.
  - "Free" or the context size on the right.
  - ctrl+a connects a provider and comes back to its models; ctrl+f marks a favourite.
- **`/connect` connects everything:** a provider's API key (Popular first, ✓ when connected), the Chrome extension and an MCP server. `/chrome` shows whether the extension is connected, or how to connect it.
- **`/mcp` manages servers:** space turns one on or off, a adds one (a command or a URL), d deletes and t tests. The prompt box border counts the ones that are on (⊙ 2 MCP).
- **ctrl+p lists every command.**
- **The conversation reads better in the terminal app.**
  - Edits show their changed lines with the file's line numbers, and +N −M on the Edit line.
  - Commands show the first lines of their output.
  - Reads say how many lines they read.
  - Attachments and pastes appear as chips under your message.
  - Your answers to the agent's questions appear as question and answer.
  - A finished thought says how long it took.
  - Each turn ends with its mode, model and time.
  - The working line shows tokens written and thinking time.
- **Questions from the agent:** you can type your own answer in place, with no separate box.
- **Permission prompts:** y, a and n answer them.
- **The welcome screen** has a block-letter mark.
- **The terminal app has its own marks:** ◆ for Atlarix's replies, ∴ for thinking, ◌ ◇ ✕ for a tool call that is running, done or failed, and ╰ for its result.

### Fixed
- **The CLI never upgrades a database an older desktop app still uses.** Desktop 14.x and older deletes a database it finds newer than itself, so installing the CLI before the app updated would have cost every session. The CLI now leaves such a database untouched and asks you to update the app first; the 15.0 app marks the database as safe the first time it opens it (`assertNoOlderDesktopForUpgrade`, `src/db/migrate_atlarix.ts`). `ATLARIX_UPGRADE_SHARED_DB=1` lets someone who no longer uses the app go ahead.
- **Cloud agent, own-key runs: found by running the action's agent step for real** (DeepSeek, a test repository):
  - The key handed over with `--api-key-file` was read, then ignored: the check deciding "this provider has no key" didn't look at it, so the run fell back to Atlarix Core. It is used now, and an own-key run never falls back to Core: with no key for the model's provider it stops with an error saying what to set.
  - A run whose turn ended on an error exited 0 as "completed", so the action would have reported "no changes". It fails now, with the error.
  - The summary that becomes the pull request description held the run's raw tool calls. It is the agent's final answer now.
- **Sessions started with a paste are named after it**, not "Pasted text with 32 lines", and the terminal picks up the model's name for a session when it arrives instead of keeping the quick first one.
- **Terminal: no more lag during long replies.** Each new piece of a reply re-read every message in the session and redrew every block on screen, and the spinner redrew the whole screen ten times a second; on a long session typing fell behind and half-read mouse codes (`<65;17`) landed in the box. Messages are now read once, only blocks that changed are redrawn, and the spinner redraws only itself.
- **Terminal: plans read like documents.** `/plan` opens a plan large, with headings, bold and code drawn, instead of a small box of raw markdown; a long title no longer runs into "esc".
- **Terminal: less green.** Headings are bold white, inline code is a chip, bullets are grey; green is kept for Atlarix's marks, links and code strings. A `---` straight under a paragraph is now a separator, not a heading that turned the paragraph green.

- **Braces no longer break answers apart.** Text such as `recordings/{year}/items/{id}`, or a JSON code
  block, was split into separate paragraphs at every `{`, in the app and the terminal.
- **Parallel calls of one tool keep their own results.** When three files were read at once, a result
  could show under the wrong file. Each result now carries its call's id.
- **In the terminal app:**
  - a message sent (or queued) right as a turn ended no longer runs alongside it. Main reports a turn's end twice, and the second report marked the session idle mid-turn;
  - after switching tabs, or clicking in the window, typing goes into the prompt box again;
  - no more "AI SDK Warning: Deprecated: image content part" over the prompt box: attached images are sent as the SDK's current `file` part (fixed for the app too), and any warning that does occur shows as a toast instead of printing over the screen;
  - copying a selection shows a "Copied N characters" toast instead of dim text in the border;
  - an unknown `/command` is no longer sent to the model; `/commands` opens the list;
  - `/mode` + Enter no longer opens `/model`;
  - prose written straight after a table is no longer drawn as table rows.
- **A question from the agent no longer comes with "Something went wrong — please try again."** A turn
  that ended by asking, with nothing said first, saved that fallback text above the question.
- **The CLI no longer crashes about a minute into a session.** It was a crash inside the Bun runtime
  the CLI was built with (1.3.8); it is built with Bun 1.4.2 now, and an older Bun refuses to build it.
- **CLI sessions keep Atlarix's answers.** Only your messages were being saved, so opening a CLI
  session again (in the CLI or the app) showed questions without replies.
- **In the CLI, pressing Enter just as an answer finished could show Atlarix as idle while it
  was still working.** The finished turn's end could arrive after the new turn began and was
  taken as the new turn's end. Ends from earlier turns are now ignored.
- **Security: a command can no longer skip its approval behind a shell prefix.** Atlarix asks
  before running risky commands, and it recognised them by their first word. Putting a variable
  assignment or a pass-through wrapper in front of a command hid that word, so it ran without
  asking. `X=1 rm file`, `X=1 curl …` and `FOO=bar ssh host` all did, as did the same commands
  behind `env`, `command`, `exec` or `nohup`. Those prefixes are now looked through before a
  command is classified (`sudo` is still treated as itself).
- **Commands no longer keep running after you quit.** Commands run in their own process group,
  and quitting while one was running left it behind. Quitting now stops them.
- **Opening your data with an older Atlarix no longer erases it.** If a newer version had
  already updated your chats' storage, an older app counted the updates, decided the data was
  broken, and deleted it to start over. It now opens the data normally when it can. When it
  can't, it says to install the newer version, and changes nothing. Atlarix also copies your data
  to `backups/before-update/` before updating how it's stored, keeping the last three copies.
- **A project's own `AGENTS.md` no longer replaces Atlarix's instructions in the `atlarix`
  command.** Run inside a repository that has an `AGENTS.md`, the npm `atlarix` command (and
  so the cloud agent) used that file as Atlarix's entire instructions. The repository's file is
  now read as project instructions, the way the app reads it.
- **A long wait for the model no longer ends the answer early.** Core's proxy now keeps a
  quiet stream alive, and starts the answer itself if the model hasn't within 45 seconds. Behind
  Cloudflare, a response that says nothing for about two minutes is cut off. A failure after
  that point still shows the right message ("out of credit", "Core is unavailable").
