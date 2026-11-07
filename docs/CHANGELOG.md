# Atlarix Changelog

> Entries are condensed to the shipped changes per version. Full prose, rationale, and
> file-level detail live in the git history.

## [Unreleased]

**Free Atlarix Auto just works.** No more "Use Atlarix Auto for free?" question in the app, the CLI or the editors: the first message on free Auto runs. What free Auto shares is in the privacy policy and terms. Pro, credit and your own keys stay private, and a Pro account whose allowance is used up is never moved to free Auto.

**Sub-agents finish their work.** Sub-agents keep going until their part is done and hand their changes back for you to accept; since 15.12.0 they stopped after one step.

**CLI: click to edit.** Click in your prompt to put the cursor there. A click no longer copies text or types over it, even when the mouse moves a little as you click, and text you copy by dragging over the prompt stays put when you type.

## [15.13.3] (2026-11-06) — Sessions that see and review each other, ask_user like Claude Code's, cheaper long conversations, and CLI sign-in kept on Windows

15.13.0–15.13.2 were tagged but never released as desktop builds (a slow package mirror, a test teardown race, then GitHub's ubuntu-latest moving to 26.04, whose rpm broke the Linux package; the Linux and quality jobs are now pinned to 24.04). 15.13.2's VS Code extension did publish. Everything below ships in 15.13.3.

**Windows sign-in kept.** The CLI and the editor extensions (VS Code, Kiro, any ACP editor) seal their session with the desktop app's OS key, and on Windows they only read it: without the desktop app the key never existed, the sign-in was not saved, and the next process started signed out (people signed in 2–4 times). They now create the key the way Chromium does (32 random bytes wrapped with DPAPI in `Local State`), which the desktop app keeps when it is installed later (checked on a real Windows machine). On Linux with no keyring, `atlarix login` says the sign-in lasts for this run only, and key lookups time out instead of hanging.

**Secrets encrypted.** Provider keys an older CLI or editor stored unencrypted (no OS key) are encrypted at the next start once the key exists, as are MCP OAuth tokens, server env and header values in the database. With no key available, the CLI says which file holds them unencrypted. Settings are written through an owner-only temporary file and a rename.

**Usage counts survive a crash.** Each turn keeps its unsent usage rows on disk, and the next Atlarix process sends what a killed or crashed one left, so daily usage no longer misses turns.

**Consent measured.** The free Atlarix Auto consent records whether it was shown, accepted or declined (`auto_consent`, only with analytics on); the wording and the flow are unchanged.

**Sessions talk again.** In the desktop app and the CLI, a message from another session starts a turn in an idle one instead of saying "waiting" (editors and the Chrome panel read it with the next prompt); a turn-ended notice is marked `kind="notice"` and never wakes anyone. A session the user stopped is not woken by a message: it waits for the user. Every surface now shows the message where it lands: "Message from <name> (<surface>): <preview>", the whole text on expand (ctrl+o in the CLI, a click in the app and Chrome, "Show all" in VS Code, the step's body in ACP editors, whose title carries the preview). In the CLI, the sender's row names the receiver instead of its session id.

**Cross-session review.** A session can see another's pending request (`list_sessions` `pending_of`: the command or the diff) and its plan, and answer it: approve, change or reject. A high-risk request (deleting files, sudo, an installer, a force-push) still needs the user.

**ask_user like Claude Code's.** Options carry a description and a "recommended" mark, questions an optional header chip, and `multiSelect` picks several: a card in the app, CLI, VS Code and Chrome; other ACP editors get a `• label: description` list answered by typing. Free text ("Other") stays.

**CLI.** A long chat shows turns that arrive with no key pressed (a peer message, a wake): the transcript stuck to the top once it outgrew the screen. ctrl+s sends everything queued now as one turn; Esc is a plain stop and what was queued comes back into the box (a stop used to throw the queue away). The terminal bell rings when a turn ends or needs you, focused or not. An image sent while a turn runs opens the next turn with it. The turn footer names the model as the picker does.

**App and VS Code.** The app chat follows the bottom on any append while you are there, not only while streaming. VS Code: a text file dropped from the desktop is attached, and the box says to hold Shift (VS Code's rule).

**Cheaper long conversations.** On Anthropic-format routes, the main conversation keeps 1h cache on its history breakpoints (sub-agents 5m), and idle compaction (below) runs there for 100k+ token histories; the plan, finished work and attachment notes ride the per-turn tail instead of the cached header; a long conversation idle until just before its 1h cache expires is compacted (`ATLARIX_IDLE_COMPACTION=off` turns it off); compaction inside a turn writes its summary on the turn's own request, read from the prompt cache.

**Prompts say only what is true.** The 11-05 audit: no "relevance-ranked" grep, the context reminder reports the working window it fires on, memory rules only where notes can be written, one tool list, one Review severity scale and output format. Review mode's "How to work" steps are global.

**Security (pre-release review).** A peer session can no longer approve a held system-scope request (sudo, an installer, a write to a shell profile): the check now judges both the held and the shown copy of the request, and refuses when there is nothing to judge. The CLI turns control characters in the text it draws from the session (peer messages, command output, model replies, dialogs and toasts) into visible symbols, so text can't retitle the tab, write the clipboard or redraw an approval card.

**Backend.** Four Supabase helpers pin their search_path; usage rollups count gated (no-credit) turns; lift-ban links are bounded to 48 h. CI type-checks on windows-latest too.

## [15.12.5] (2026-11-04) — the context meter and the model's reminder agree on one number

**Context meter.** The "context is at X% capacity" reminder the model sees and the percentage in your context bar now share one denominator — the model's full context window. They had diverged: the reminder counted against the 256k working window and read "198%" while the bar counted against the 1M window and read "48%" for the same dispatch. Both now report the full window, and the reminder still triggers compaction at the working window, unchanged.

## [15.12.4] (2026-11-04) — A context meter that reads real, local-first memory recall, and a dock that clears finished sub-agents

**Context meter.** The CLI's context bar now shows the provider's real billed input-token count — the whole prompt it dispatched — instead of a local estimate, so the percentage matches what you're charged. The local estimate is kept only to trigger compaction, where it belongs.

**Permission cards.** Long command text in a permission approval card now scrolls instead of overflowing the card.

**Memory recall.** Recalling project-memory notes is now local-first: a deterministic keyword score over each note's name and description, boosted by a per-note weight the learner adjusts as notes are used or go stale. The small-model recall runs only as a fallback, so a slow provider no longer delays a message while notes are recalled.

**CLI dock.** A background sub-agent that failed (rather than was cancelled) no longer stays pinned to the bottom strip after it ends — its record is marked finished on every path, so the dock clears it.

## [15.12.3] (2026-11-03) — Case-insensitive project instructions, proactive image gate, MCP sign-in guidance, and selector infrastructure

**Project instructions.** `atlarix.md` and `.atlarix/atlarix.md` are now found regardless of casing — `ATLARIX.md`, `Atlarix.MD` and any other variation all work. The old migration code that renamed files is gone.

**CLI layout.** Tool cards during streaming now render at the top of the scroll area (following the messages) instead of being pushed to the bottom of the viewport when there's little content.

**Image handling.** Models that can't see images (text-only models) now reject a request with images immediately, before sending it, with a clear message naming the model and suggesting one that can. Before, the request was sent and failed at the provider.

**Peer messages.** Queued peer messages in the composer now show a readable preview ("From [name]: [first line]...") instead of the raw XML envelope.

**MCP sign-in.** When an MCP server needs a pre-registered OAuth app (like Slack's MCP server), the error message now explains what to do and points to the setup guide, consistently across the app, CLI, editors and VS Code panel. Sub-agent tool calls now carry their own IDs in trajectory files, so the cloud runner can pair them and show them as the helper's work.

**CLI.** The rating prompt now fetches fresh timing data on each check, consistent with how the app does it, so a rating asked in one session isn't asked again in another. The `/context` command shows the effective budget (`tierLimit`) instead of the raw context length, matching what the context meter uses.

**Chrome extension.** `axe.min.js` is now `axe.js` to comply with the Chrome Web Store's policy against obfuscated code.

**Infrastructure.** The `auto_steps` table records metadata (never content) for each paid Auto/Zenith step — which lane, level, provider, tokens, latency and outcome — for the model selector to learn from. The `mcp_oauth_clients` table stores sealed OAuth clients for MCP connectors, and `cloud_setup_prs` tracks setup PRs the cloud agent opens so they can be capped.

## [15.12.2] (2026-11-02) — Blinking approval indicator, queued-message send on Esc, and instant new-session visibility

**CLI.** The `<!>` tab-title indicator now blinks (alternates with spaces every 300 ms) so a session waiting for your approval is unmistakable from another terminal tab. Pressing Esc or Ctrl+S while a turn streams now pops and sends the first queued message immediately after the interrupt, instead of leaving it queued. Ctrl+S also triggers on a queued message, not only on deferred commands.

**Sessions.** A brand-new CLI or app session is now visible in `list_sessions` the moment it registers, even before it sends its first message (ATLARIX-48). The blank-session filter that hid it was narrowed to the editor surface only, where it was designed to suppress the auto-created empty session VS Code opens on workspace load.

## [15.12.1] (2026-11-02) — CI test fix

**Tests.** Aligned the bun CLI/ACP test suite with 15.12's shipped behaviour: the plugins mock, usage tracking mocks, context border text ("context 23%"), and the memory-bounded test's RSS ceiling for CI variance.

## [15.12.0] (2026-11-02) — Silks and Edicts, a workspace that pays, and a context that compacts before it hurts

**Silks, Edicts, and mods.** Plugins are now **Silks** and hooks are now **Edicts**, everywhere you see them; mods keep their name. A Silk is a folder you install that can add skills, agents, MCP servers and slash commands to Atlarix, and it runs in its own isolated sandbox with a status line, toasts and a `/silks` view on every surface. An Edict runs around a tool — before or after it, or to block it — and a Silk's or Edict's refusal reads as a rule gate, not an error.

**A workspace that pays.** In Slack, one account can pay for a whole workspace's Atlarix work, hand that role to another member, or give it up (back to everyone paying for themselves); if the payer goes, it falls back to everyone pays. The Usage screen, `/usage` and the VS Code Usage view gain a Team section: who's in the workspace, what the pot paid, per-workspace totals, and channel labels.

**One context window, and compaction that works at it.** One working window for every model — default 256,000 tokens, set in Settings → General, `/context`, the VS Code settings, and the ACP "Context" command. The meter is a percentage, and compaction runs at that same window, mid-turn too, with a hard ceiling on very large models. The prompt cache now survives from turn to turn (the per-turn tail no longer sits in front of the history), so repeat turns cost less; a provider that rate-limits now backs off instead of failing; and a session already over its window can always be compacted — `compress_context` compacts instead of answering "nothing worth summarising".

**Sessions review each other's permissions.** One session can now review another's pending permission requests and plans — approve, deny or replace them — on top of following, steering, stopping and forking it.

**Billing and refusals that read right.** Billing and gate refusals are answers, not "AI errors"; a model keeps one name everywhere (Core rows named alone, no vendor suffix); and the picker shows Credit and Free tags, the five wallet-and-limit messages, and a free-Auto hold with a countdown. The Core lineup gains a sixth slot.

**Reliability.** macOS signing now retries and then fails the build (no unsigned release), and every Mach-O must carry the Team ID; Linux .deb/.rpm installs relaunch after an update; the Windows update banner re-checks after a failed download; and a stalled background command shows as "supervising" instead of "running".

Plus the usual: a paste sent with a typed message is never dropped, a genuinely short chat reads "still short" again, an approval receipt anchors under the row that asked, and the CLI's Message and Sessions rows say what they did.

## [15.11.1] (2026-10-25) — updates that really install, sign-in first, and a chat keeps its own model

**Auto-update everywhere.** Intel Macs now update: the Mac feed lists both chips (the live 15.11.0 feed was fixed the same day, so Intel installs already reach 15.11.0). Linux .deb and .rpm installs update themselves like the AppImage: the new version downloads in the background and installs when you quit, asking for your password once. The .deb/.rpm declare the libraries computer use needs, the Windows CLI's file details carry Atlarix's copyright, and a failed install on quit no longer crashes the app.

**Signing in comes first everywhere.** The CLI, the VS Code panel and editors like Zed open on a sign-in screen with the same choices as the app (GitHub, Google, Discord or email), plus a code for SSH and remote machines; editors ask before the first message, not after it fails. Asking for a code again shows the same code while it's still good, so going back and forth can't lock you out for ten minutes.

**Each chat keeps its own model, effort and mode.** Picking one in a chat changes only that chat, and a new chat starts with your last pick; chats from before the update keep what they were using. Build-mode wrap-up steps (the build snapshot, marking a plan as built, the session summary) follow the mode the turn ran in, in the app and the CLI.

**Never moved to Atlarix Core behind your back.** If the model you picked has no key, or its saved key can't be read (a locked keychain, a refused keychain prompt, settings copied from another machine), the turn stops and says so ("No key for <provider>…" / "Can't read the saved key for <provider>; re-enter it with /connect") instead of quietly running on Atlarix Core. `--provider-url` runs use the key they were started with, whatever is saved, and two of them against different endpoints on one machine each keep their own endpoint and key, each listed by its address (the endpoint you used last keeps its computer-use switch; on any other, switch it on again once).

**Notifications, not sounds.** Atlarix no longer plays sounds. When it needs your approval or an answer, or finishes, while the app is in the background, you get your system's notification, with its own sound and Do Not Disturb. It names the chat, a click opens that chat, and a batch of approvals is one notification. It has its own switch in Settings → Notifications; if you had turned the old sound off, notifications stay off until you turn them on. On Linux, text that looks like markup ("<Button>", "&") shows as written.

**Approvals that hold.** "Allow all this turn" covers every edit in the turn, including ones Atlarix had to match loosely, and notes in the agent's memory folder never ask. Stop withdraws the turn's open approvals everywhere (an approval left on screen can no longer apply a stopped edit), and each chat shows only its own approvals and count. A change you denied stays denied for the rest of the turn, even when the model hands it to a sub-agent, and the end-of-turn recap lists only the files that really changed.

**Computer use.** The CLI and editors show "Computer use on" when it is on for the model, wherever it was switched on. A model that refuses Atlarix's computer tool version is sent the version it accepts (once per model, remembered), instead of losing the native tool.

**Small.** A reply is labelled with the model that wrote it, also when it came from the CLI or your own endpoint (by name, never an internal id); the end-of-turn recap shows files outside the project as ~/… .

## [15.11.0] (2026-10-24) — computer use, sessions that steer and read each other, and a harness that carries less

**Computer use.** Atlarix can now see your screen and use the mouse and keyboard, on macOS, Windows and Linux (X11 and Wayland; Wayland is untested on real hardware). Models with their own computer tool use it; any other model that takes images gets Atlarix's own `computer` tool; text-only models get neither. It is **off by default** and switched on per model: in Settings → Computer use, the chat's model menu, `/computer` in the CLI, the VS Code panel's settings and the session options in ACP editors. A model that can't use it shows why instead of a switch. There are no approval cards for clicks or typing: it's your decision when you switch it on. It is offered in Build and Debug only, and only one session controls the screen at a time. While it runs, the app shows a "Controlling your screen" pill (hidden from the model's own screenshots) with Stop and ⌃⌥Esc, and the CLI posts a notification; in editors each action is a step in the chat and the editor's Stop stops it. **Moving the mouse stops it on every surface:** its next click or keystroke is refused and the turn ends, so nothing lands against you (Esc and ⌃⌥Esc stop it at once). It works on whatever is open on your screen, so close what you don't want it to touch. On macOS it needs Screen Recording and Accessibility once; Atlarix says which app macOS will name (Atlarix, or the terminal or editor it runs in) before the prompt appears. On Windows, typed text is pasted and your clipboard is put back, kept out of clipboard history.

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

