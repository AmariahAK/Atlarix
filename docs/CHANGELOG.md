# Atlarix Changelog

> Entries are condensed to the shipped changes per version. Full prose, rationale, and
> file-level detail live in the git history.

## [15.11.0] (2026-10-24) — computer use, sessions that steer and read each other, and a harness that carries less

**Computer use.** Atlarix can now see your screen and use the mouse and keyboard, on macOS, Windows and Linux (X11 and Wayland; Wayland is untested on real hardware). Models with their own computer tool use it; any other model that takes images gets Atlarix's own `computer` tool; text-only models get neither. It is **off by default** and switched on per model: in Settings → Computer use, the chat's model menu, `/computer` in the CLI, the VS Code panel's settings and the session options in ACP editors. A model that can't use it shows why instead of a switch. There are no approval cards for clicks or typing: it's your decision when you switch it on. It is offered in Build and Debug only, and only one session controls the screen at a time. While it runs, the app shows a "Controlling your screen" pill (hidden from the model's own screenshots) with Stop and ⌃⌥Esc, and the CLI posts a notification; in editors each action is a step in the chat and the editor's Stop stops it. **Moving the mouse stops it on every surface.** It works on whatever is open on your screen, so close what you don't want it to touch. On macOS it needs Screen Recording and Accessibility once; Atlarix says which app macOS will name (Atlarix, or the terminal or editor it runs in) before the prompt appears. On Windows, typed text is pasted and your clipboard is put back, kept out of clipboard history.

**Sessions steering sessions.** One session can now set another session's mode and model (from the providers you have set up), and review another session's plan: approve it (it starts building, exactly as if you clicked Build), reject it with a reason (it re-plans), or replace it. The target shows a line saying who changed what ("Plan approved by Rix. Building it."), in the app, the CLI, VS Code and Zed; a change is refused while that session is mid-turn. `list_sessions` shows each session's model and any plan waiting for approval, and long model lists are shortened.

**How is Atlarix doing?** After six turns, every surface asks once per session to rate it 1–3 (bad, fine, good), and `/feedback` sends a note any time, in the app, the CLI, VS Code and any ACP editor. Nothing is sent unless you answer; signed out, the answer goes without an account; it never reaches the model. The "where did you hear about Atlarix" and PeerPush asks are gone, and VS Code no longer asks for a Marketplace rating.

**Sessions read each other's results.** `list_sessions` with `result_of` shows another session's latest finished turn: how it ended (with the error kind if it failed), its reply (long replies are cut, with how to ask for the rest) and the files it changed, or "still working" with its last result. A session you forked away from no longer shows as reachable, and a message to a session that isn't open any more says it wasn't sent.

**Session names follow you.** `/undo` to the first message, or a first message from another session, names the session everywhere; the app's chat header shows the session's name; the CLI keeps the name in view while a turn runs; the VS Code tab and sidebar header show the chat's name, and a rename in the CLI reaches the app within a second.

**Clickable links.** URLs are clickable in the CLI (terminal hyperlinks, with the address shown where the terminal can't link), in run_command output, notices and dialogs; ACP editors get each URL in command output as a link; the VS Code panel links command output, failed steps and messages from other sessions. Only http(s) links are made clickable.

**A harness that carries less.** The mobile tools are gone: a model drives an emulator or simulator with `run_command` and `view_image`. The first-run wizard, guided tour and coachmarks are gone (the analytics choice still comes first). Image tools are offered only to models that can see images, and the browser tool now says when a screenshot helps instead of forbidding it. Rotating tips are gone from the app, CLI and extension; Help → Community opens Discord directly; and a long session's "older messages not loaded" notice is one quiet line.

**Chrome extension.** "Allow on every site" (account drawer → Sites, off by default) lets Atlarix work on any site without asking site by site; password fills, connectors and other always-ask actions still ask. A site you've limited in Chrome's own site access now says "Chrome is blocking Atlarix" instead of asking again, and keeps your Atlarix grant for when Chrome allows it.

**The cloud agent is a paid feature.** Cloud runs, from Slack or atlarix.dev, use Atlarix's models only (paid Atlarix Auto or a paid Core model) and are billed to your Atlarix balance; the own-key option is gone. Use your own key in the app, the CLI or your editor.

**glob and grep find everything.** A folder outside the workspace keeps its own ignore rules (not the workspace's), `~` paths work, an unreadable folder no longer ends the search, anchored ignore rules apply, a single file given by absolute path matches, and paths read with `/` on Windows too.

**VS Code.** A New chat is saved at its first message, not before; Past chats updates while open; a failed start says why with Retry instead of hanging on "Starting…"; a `.cmd` CLI path works on Windows; and `atlarix.cliPath` can only be set in your own settings, not by a repository's `.vscode/settings.json`.

**Headless and the CLI.** `atlarix run` accepts `--api-key-file` with `--provider-url`, says how to pass a key a remote endpoint needs instead of falling back to Core, never rewrites the profile's settings, and an unattended run is never left waiting on a sandbox card.

**Smaller fixes.** The app falls back to a second Core proxy when the first can't be reached; with analytics on, a share of app sessions are recorded as layout and clicks only, every word and input masked; a test profile no longer rewrites the browser's native-host files; ratings and analytics carry the right app version; CLI notices show their whole text instead of one line; a session-title request that fails is no longer sent twice; screenshots carry an "untrusted content" note like every other page read; Claude through Bedrock or a custom Anthropic-format provider can see the images tools return; a sign-in on any surface records which surface, version and OS it came from; crash reports carry your account ID, never your email.

**Microsoft Store.** The Store build asks for less: it writes only the browser bridge's own registry keys outside the package (Windows 11), instead of turning off registry isolation for the whole app.

## [15.10.0] (2026-10-21) — project memory that recalls, live sessions and /fork everywhere, safer approvals, and compaction that works

**Project memory.** Atlarix keeps what it learns about a project in notes, one fact each, with a `MEMORY.md`
index. The index is shown once when a session starts (and again after `/compact`) instead of on every turn,
so adding a note no longer breaks the prompt cache. Each message is matched against the notes, and the few
that fit are attached as background, with how old they are, once per session. If `MEMORY.md` changes on
disk while a session is open (another session, the CLI), the next message says so. Notes the agent writes
are stamped with the date and the session that wrote them, and a large index asks to be tidied. The check
for matching notes is one small extra request per message, billed like any other; `ATLARIX_MEMORY=off`
turns all of it off.

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

**A long chat costs less per message.** Each message's own words were sent twice, the second time in the part
that changes every turn, so everything said before it was sent again uncached on every message. It is now sent
once, and the conversation so far is read from the provider's prompt cache: on Claude, each new message writes
only itself, where it used to rewrite the whole chat.

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
