# Atlarix Changelog

> Entries are condensed to the shipped changes per version. Full prose, rationale, and
> file-level detail live in the git history.

## [Unreleased]

**Long conversations stop forgetting what they were for.** When a chat runs long enough to be
summarized more than once, each new summary was rebuilt from a mangled copy of the previous one —
flattened onto a single line and cut off partway through, which reliably threw away the sections
holding error messages and file paths. Later summaries were compressing damage rather than the
conversation. Each summary is now handed forward intact and updated in place, so a session that has
been running all day still knows the task it started with.

---

## [14.37.0] (2026-08-24) — Deep thinking on Atlarix Core, web search that finds what you asked for, and a record of what the agent has written

**Deep thinking works on Atlarix Core.** The toggle was missing for every Core model while the same
model on your own API key had it — and underneath that, it was reaching the provider for neither.
Atlarix now asks each model what reasoning control it actually supports and sends that control on
every route, so turning Deep thinking on genuinely asks for the model's maximum instead of changing
nothing. On Core it also stops asking for one notch less than the model offers.

**Web search finds what you asked for.** Searches were being cut down to six keywords before they
left the app — an exact phrase in quotes was broken apart, an author's name at the end was dropped,
and what reached the search engine was a fragment. Deep search made it worse by always searching
developer sites and ranking ordinary web results last, so asking about a book returned
programming pages. Searches now go out as written, deep search looks where the question points, and
a search that found pages can no longer come back empty because a relevance filter disliked all of
them.

**You can see how much the agent has written for you.** Settings → your profile now shows lines
added and removed per project, which model did the writing, and a contribution calendar of your
daily activity. It tells Atlarix Core apart from the same model on your own key, and it counts what
was actually applied — including when you accept only some hunks of a change. It records edits the
agent makes through its file tools; changes made by commands it runs are not included, and the card
says so. Everything stays on your computer.

**Tool cards stop showing each other's results.** When the agent ran two searches at once, one
card could display the other's results while the other reported nothing found. The searches
themselves were always correct and so was the agent's reading of them — only the transcript was
wrong, which made it look as though the agent had invented an answer. A search that genuinely finds
nothing now says which query came up empty instead of just "Done".

**The work-mode chip tells the truth.** It could show one mode while the picker beside it showed
another, and Shift+Tab announced a mode change that never took effect for sessions with their own
mode — the toast appeared, the next turn ran in the old mode. Both controls now read and write the
same place. A turn keeps the mode it started in, so while one is running the chip shows the mode
that turn is actually using and the picker marks your new choice as applying to the next message.

## [14.36.0] (2026-08-22) — Diagnostics you can run yourself, a database error that tells you what to do, and Debug that finally works like Build

**Debug mode now gets the full working loop it was always meant to have.** Debug has always been a
writing mode with the same tools as Build — the difference was meant to be discipline, not
capability. But internally it was being run like a read-only mode: it got one pass per turn and
skipped the checks that make Build finish what it started. So a Debug turn would stop early where the
same request in Build would keep going, and it never ran the project's own checks before declaring
itself done. It now takes the same path as Build, while still reading and behaving as Debug.

**There is a Diagnostics screen, and it checks the things that fail quietly.** Settings →
Diagnostics runs through your account and Core balance, every API key you have saved, the model
catalogue, the OS keychain, search, the terminal, the local database and the command sandbox — and
each row that fails tells you what to do about it rather than just going red. Keys are checked by
asking each provider for its model list, never by generating anything, so running diagnostics can
never cost you money. "Copy report" gives you something safe to paste into a support message: API
keys, tokens, email addresses and file paths are stripped out, keeping only the filename at the end
of a path, because that is the part that identifies the problem rather than you. If the app will not
open far enough to reach Settings, the same checks run from a terminal with `--doctor`.

**A database error no longer tells you to do the one thing that cannot help.** When Atlarix could not
open its database it said "Please restart the app" — but it had already retried and cleaned up
automatically before showing you anything, so restarting was guaranteed to produce the same message.
It now names the actual cause and gives you buttons: download the current version, show the logs, or
quit. It also tells apart the case where your data was written by a NEWER version of Atlarix than the
one you are running — there, nothing is damaged and nothing needs deleting, you just need that newer
version back.

**Your work mode now belongs to the conversation, not the window.** Picking Plan in one session and
Build in another used to be impossible: the mode was a single app-wide setting, so re-opening a
session you had been planning in could quietly start writing files. Each session now remembers its
own mode, and sessions you already have keep following the global preference until you deliberately
pick a mode in them.

**Answers no longer stop mid-sentence when a provider hiccups.** Some providers report a failure by
returning a perfectly normal-looking response whose ending reason is the error. Nothing looked wrong,
so Atlarix treated a truncated answer as a finished one. It now recognises that case and retries, the
same way it already handled a dropped connection.

**Atlarix uses less memory when you keep several sessions open.** Switching away from a conversation
now frees what was being held to draw it, and switching back reloads it. Anything still streaming is
never touched, so background work keeps running exactly as before.

**Clicking Skills on the Free plan no longer throws you into a payment page.** It opens the Skills
screen and explains that installing Agent Behaviours needs Pro — the same way the MCP marketplace
already did. Project instructions and any behaviours committed to your own repo keep working on Free.

**Smaller things.** The agent is told where its project memory lives at the very top of its
instructions, instead of part-way through, so it stops searching for a location it already had.
Restoring the "revert file changes as well" option after a restart works again — it had been silently
failing. And an internal error during shutdown no longer reports itself as a crash.

## [14.35.0] (2026-08-20) — web search that actually finds things, passkey sign-in that stops hanging, and a browser five versions newer

**Signing in with a passkey no longer hangs the page.** If a site offered you more than one saved
passkey, Atlarix's browser had nothing listening for the question — so the page simply waited, for
ever, which read as the browser being broken rather than as a feature being unfinished. Later it
refused outright, which was worse: a security key holding two credentials could never be used at
all. Now it asks which account you want, and a security key with several credentials works.

**And when a site asks for a passkey Atlarix can't provide, it tells you what will work.** Atlarix's
browser has no authenticator of its own on any platform, so a site asking specifically for a passkey
*stored on this device* can't be satisfied here. Instead of a silent wait you now get a note saying
to choose "use a phone or tablet" and scan the QR code with the device your passkey is on, or to use
a security key. Both of those go through the browser normally, and the passkey on your phone is the
same one you set up elsewhere.

**Web search works again.** If you use Atlarix's own AI (Core) and asked it to search the web, it
was very likely finding nothing — not fewer results, none. The free services it fell back on have
quietly stopped being usable for this: one of them only ever returned encyclopaedia summaries rather
than search results, and the rest now refuse requests that don't come from a real browser. Atlarix
*is* a real browser, so it now searches with the one it already ships, invisibly and in the
background. On three ordinary programming questions that previously returned nothing at all, it
returned 24, 29 and 25 results. This is not the AI browsing on your behalf and it never opens a tab
you can see — it is the search underneath, doing what it always claimed to.

**And it can now read pages that need a browser to make sense.** Asking Atlarix to read a specific
page used to fetch the raw file and nothing more, so a modern site that builds itself after loading
came back as an empty frame, and a site that screens out non-browsers came back as a refusal. It now
tries the quick way first and falls back to actually rendering the page when that returns nothing
useful — so documentation sites, dashboards and anything behind a bot check read properly. The quick
path is still the normal one, which matters: a deep search reads several pages at once, and rendering
every one of them would have made it several times slower for no benefit. Pages it reads are also
shared and cached across a single question now, so the same link is never fetched twice.

**Setting up web search is no longer a thing you can do wrong.** The old settings page walked you
through installing a search engine in Docker — a whole flow, for a fallback that measurably returned
nothing. It is gone. Search needs no setup at all now. If you already run your own search server,
there is a single field to point Atlarix at it, and it checks the address actually answers before
saving, rather than letting you save one that quietly never works.

**The browser underneath is five major versions newer.** Atlarix was running a Chromium that stopped
receiving security fixes some time ago. It now runs the current one, which also starts faster — the
app boots from a prebuilt snapshot and caches its startup scripts as compiled bytecode.

**A large amount of machinery underneath is now current.** The AI toolkit Atlarix uses to talk to
every model provider, the build system, and the type checker all moved up a major version — around
fifteen packages in total. None of it changes what the app does, which is the point: it keeps Atlarix
on versions that still receive fixes, and it removed a handful of quiet faults on the way, including
one where a scheduled automation could never have found the helper it needed to run.

**Fewer ways to be attacked through a file you were sent.** Production security advisories went from
54 to 28, and the two most severe are gone. The spreadsheet reader was the notable one: the library
Atlarix used to open `.xlsx` and CSV attachments has been abandoned by its author with two unfixable
flaws, and that code runs on files other people send you. It has been replaced with two maintained,
read-only libraries, and spreadsheet reading now has real test coverage it never had before.

**Searching your own code stopped quietly missing files.** If a file contained a certain invisible
character, Atlarix's search skipped it silently and reported no matches — so the code was there, the
search said it wasn't, and nothing indicated a file had been skipped. Four files in Atlarix's own
source were affected. Search now reports such files instead of ignoring them.

**Approval requests can no longer disappear.** When Atlarix asked to write somewhere outside your
project, the request could be raised without ever drawing the card that lets you answer it — so the
turn sat there working on nothing, for as long as you let it, and Stop was the only way out. The
request now reaches every part of the screen that needs it. The same fault was quietly swallowing
the "command blocked" and "file blocked" notices, so those appear now too.

**Atlarix stops losing its own project notes.** Its memory lives in a per-project folder outside
your repo, and the path was only ever shown once at least one note existed — so on a new project it
had no idea where to write the first one and guessed, leaving notes in a folder nothing would ever
read again. It kept guessing, because the real folder stayed empty. Atlarix is now told the exact
folder from the start, and any notes stranded by the old behaviour are moved into the right place
the next time you open that project, with the stray folder cleared away. It also no longer goes
looking for that folder on its own: it was told where its notes live and then searched anyway, found
an old stray copy, and spent the rest of the session editing notes that were about to be tidied away
underneath it.

**Messages can no longer come back in the wrong order.** Anything written in the same second shared a
timestamp with no tiebreaker, so reopening a conversation could show a reply above the question it
answered — and, less visibly, editing a message could remove the wrong one or leave a stale answer
behind. Ordering is now exact.

**Reasoning on your own Anthropic key was never actually being requested.** If you used a Claude
model with your own API key and turned on deep thinking, Atlarix asked for it in a place nothing was
listening — so you paid for a thinking model and got a non-thinking answer. It now asks properly.
Worth being straight about the limits of this one: it is fixed by inspection and covered by tests, but
we have no Anthropic key here to send a real request with, so it has not been watched working.

**Cmd+R no longer reloads the app.** It was never meant to: reloading mid-turn throws away whatever
the agent was doing. The shortcut simply does nothing now.

**A large amount of dead machinery is gone.** Atlarix began as a fork, and it had been carrying whole
features nothing could reach: a hosted AI gateway pointed at a server that no longer exists, a
project-details screen with no way in, a visual editor for a preview pane removed several versions
ago, a container mode no setting could turn on, and an edit format only that dead gateway ever
produced. None of it was reachable, so nothing you use changes — but a "Refresh app" button that did
nothing, and an "Atlarix Pro" toggle wired to a dead server, are no longer there to click. The in-app
help bot went with them; docs, Discord and bug reports are unchanged.

**One build setting could have weakened four protections at once.** A flag meant for the old automated
test suite, when switched on at build time, would store your API keys unencrypted while still
reporting them as encrypted, send GitHub sign-in to a different address, skip signing the app, and
ship it with a debug port open. The test suite that needed it is gone, and so is the flag — all four
are now unconditional.

**The Plan panel says which plan it is showing, and lets you switch.** A session can hold several
plans, but the panel only ever showed the newest one — so one plan was presented as though it were
*the* plan, with nothing on screen saying the others existed. There is now a list at the top when a
session has more than one, and picking an older one keeps it on screen: Atlarix starting work on a
different plan no longer yanks the panel away from what you were reading. Choosing "Latest" hands it
back to following along.

**Atlarix can now refer to a plan by name.** It could previously only address a plan by an opaque id
— which weaker models routinely drop — or by "the newest one". It can now say which plan it means. If
two plans share a name it stops and asks rather than guessing, for the same reason it refuses to tick
a step it cannot uniquely identify.

**Steps now stay ticked.** Marking several steps done at once could silently lose most of them —
each mark rewrote the whole plan from a copy read moments earlier, so the last one to finish erased
the others and those steps reverted to unstarted. Marking a step could also be refused outright when
its text contained formatting (bold, backticks, a symbol like ×), because the match had to be
character-for-character. And a plan whose steps were all *in progress* displayed as "0 of 6 done"
with no mention of the six underway, which is indistinguishable from a plan that has been wiped.
Together those three made Atlarix distrust its own checklist: it would conclude the tracker was
broken, rewrite the plan from scratch, and lose the record of what it had already finished.

The last piece of the same problem: on a long task Atlarix works in several passes, and at the start
of each new pass it was handed the step counts from the *beginning* of the whole task rather than
the current ones. So it could tick three steps, then immediately be told only one was done, and
start arguing with a stale number instead of carrying on.

**Automations can be tested the moment they are created.** Atlarix's own instructions tell it to run
a new automation straight away to check it works — but the id it needed to do that was never handed
back after you approved the creation, so it either gave up or went hunting by name. Names are not
unique, so that could have run the wrong one. It now gets the id.

**A large amount of dead machinery is gone — about 30,000 lines.** Atlarix began as a fork, and it
had been carrying whole features that nothing could reach: a hosted AI gateway pointed at a server
that no longer exists, a project-details screen with no way in, a visual editor for a preview pane
removed several versions ago, and a container mode that no setting could ever turn on. None of it was
reachable, so nothing you use changes — but it also means a "Refresh app" button that did nothing,
and an "Atlarix Pro" toggle that connected to a dead server, are no longer there to click. The
in-app help bot went with them; the docs, Discord and bug-report routes are unchanged.

**On-device voice dictation now runs under the app's security policy.** It was the one part of
Atlarix exempt from it, by accident rather than design — the protection is applied to the app's own
page, and the separate worker that does the transcription did not inherit it.

- Choosing a folder — opening a project, importing one, picking where to save a clone — still asks
  every time; on macOS the picker now starts in Downloads rather than wherever you were last, a
  change that comes from the OS rather than from Atlarix.
- Desktop notifications now require the app to be signed in order to appear, which affects
  development builds only — released builds are signed.

**Accounts can be suspended.** If an account is suspended, Atlarix says so plainly, points
to support@atlarix.dev, and offers to sign out — it does not fail with a confusing error or
pretend to be broken. The reason is never sent to the app, and a suspended account cannot
lift its own suspension. Nothing about this affects anyone whose account is in good
standing.

## [14.34.0] (2026-08-18) — Atlarix tests its own work, and two windows stop fighting over one mode

**Stop now stops, even when Atlarix is waiting on you.** If it asked permission to write somewhere
outside your project — where it keeps its notes about a project, for instance — the turn would wait
for your answer, correctly and for as long as it took. But pressing Stop did nothing to that wait,
and answering the question much later still went ahead with the write. Stop ends it now.

That wait is also easier to notice. It said "Waiting for your approval" while still showing the
thinking animation, so it read as Atlarix working rather than Atlarix waiting; it now gets the same
amber timer as a long-running command, and clicking it jumps to the request. And the bar above the
composer says what is actually being asked — the folder it wants access to — instead of "1 approval
waiting", which told you nothing about what you were about to allow.

**Command output stopped being thrown away.** When a command produced more output than the
budget allowed, Atlarix was keeping about thirteen lines of it — roughly 1% of what it was allowed
to keep — and reordering what survived into an errors-first summary. On a long build or a big
listing that meant the model saw a scrambled fragment, decided the output was truncated, and went
off writing the command's output to a temp file to read it back. Two wasted turns to recover
information that already fit.

It now fills the budget it has — around 1,600 lines instead of 13 on a large build log — keeps it
in the order it happened, says exactly how many lines were skipped in the middle, and separately
lists any error lines that fell into the skipped part so a failure buried mid-build is still
visible.

**"Allow all" now means the rest of the turn.** It used to clear only what was queued at that
instant, so the next command asked again — and on a turn that runs several tools in a row (each of
which trips the safety prompt on its own) you ended up clicking it once per command. It now covers
everything that turn goes on to ask for, and it still saves no permanent rule: it ends when the
turn ends, so one click can never become a standing grant.

- Removing a workspace no longer warns about deleting files when it isn't going to. Taking a
  project off the list says what it actually does — it goes off the list along with its saved
  sessions, and nothing on disk changes. The stronger warning is kept for the one case that really
  does delete a folder, and it now shows you the path. Both use an in-app dialog rather than the
  system pop-up that looked like an OS warning.
- Fixed: on Windows, removing a workspace that Atlarix itself created showed the *reassuring*
  message and then deleted the folder anyway.

**Atlarix can now QA its own work.** After building something, it can hand a worker the
requirement and the URL — deliberately *not* the diff — and have it go exercise the running app
independently. It gets a real terminal and the real browser, because running the thing is the
whole point: a tester that has to ask someone else to run each command is not testing, it is
writing a script. What it cannot do is change anything. It has no ability to edit files, and every
command it runs is confined by the operating system to reading only, so it can run your test suite
and hit your API but cannot touch your repo.

It reports what it saw, with the evidence: a status code, a console line, a log excerpt. Finding
nothing is a real result and it is allowed to say so — *"exercised these three things, all
worked"* is a complete answer. "Broken" and "couldn't reach it" stay separate, because they are
different problems. Everything it reports is a claim Atlarix then reproduces before acting on it,
the same way it already reviews a sub-agent's proposed code changes.

If a QA worker needs to run something genuinely risky, **it asks you — and the request says which
worker is asking.** Sub-agents previously had no way to ask at all, which sounds safe and was
actually the reason they could not run commands: a worker nobody can hear is either mute or
unsupervised. Declining affects just that one command; the worker carries on and tries another
route.

- The plan's name now reaches the model, not just the screen. Storing it fixed the Plan panel and
  left the agent still reading a heading scraped out of the markdown, so a session resumed a day
  later showed a correctly-named plan to you and an unnamed one to Atlarix.
- When Atlarix delegates a plan step, it now marks that step in progress as it hands it over and
  done once it has reviewed what came back — so the plan reflects the work rather than the intent.
- Fixed: a sub-agent's browser actions could land in **whichever window you happened to be looking
  at**, and switch windows mid-task if you did. They now stay in the window that started the work.
- A workspace agent whose `tools:` list names nothing usable now says so, instead of starting with
  no tools and no explanation.

**A second window could silently turn the first one read-only.** Atlarix kept exactly one work
mode for the whole app, and every in-flight turn re-read it on each tool call. So opening a second
window — in Explore, or just opening it at all on a read-only chat — retuned the sandbox of a turn
already running in the first window. Commands that were meant to write started failing at the
operating system, `git` most visibly of all:

```
error: cannot lock ref 'HEAD': Unable to create '.git/HEAD.lock': Operation not permitted
```

Nothing on screen said so. The first window still showed **Build** the whole time, because a
settings change in one window was never announced to the others. It read like a broken repository,
and it was not.

A turn now carries the mode it started in, from beginning to end. This was not one bug but five
places that each re-derived the mode from global settings; the worst of them gave *unattended
automations* Build-mode tool access whenever your saved preference happened to be Build.

**Plans have real names again.** A plan's title used to be spliced into its markdown and scraped
back out, and the splice was skipped whenever the plan body opened with a heading. Since most
models open a plan with `## Goal`, most plans lost the name the model gave them and displayed as
*"Goal"*. Titles are now stored, required when a plan is created, and shown in the Plan panel — so
a session with several plans says which one you are looking at.

**Every mode now shows the model a smaller tool surface.** Tool instructions had grown to roughly
7,000 tokens sent on every single turn. Each mode keeps its workhorse tools documented in full and
binds the rest with a one-line summary plus `tool_help` for the details — about 2,000 tokens back
per turn, with no tool becoming unavailable and nothing lost to prompt caching. Guidance that
exists to stop a known mistake is never shortened, because a model about to make that mistake does
not know to go looking for more.

- A tool call rejected for bad parameters is now written to the log. Three failed edits in one
  session previously left no trace anywhere, which made them impossible to diagnose.
- Reviewing a sub-agent's proposals now accepts an id that is missing its `prop_` prefix — the
  error message printed that id and told the model to use it, then refused it.
- Marking a plan step done no longer silently does nothing when the model appends a stray
  character to the step text.
- The Plan panel drops its *Add step* and *Mark built* buttons: both did what asking the agent
  already does, and a hand-set status is a state the agent never agreed to.

## [14.33.0] (2026-08-17) — Automations that actually tell the agent

**Your automations were running and telling nobody.** If an automation was set to notify the
agent, it ran on schedule, wrote its row into the feed, sent its notification — and the agent
never heard a word. The result was being recorded correctly all along; nothing was picking it up.
The next time you opened that workspace and asked a question, the finished run was simply
missing from what Atlarix knew.

That was the worst kind of silence, because everything visible looked fine: the run happened, the
feed updated, the notification arrived. Only the part you could not see was broken. A finished run
now reaches the agent on your next message in that workspace, exactly as background commands and
sub-agents already did.

Automations still never interrupt you. A finished run waits for the next thing you ask rather
than starting a turn on its own — an automation cannot decide to spend your credits while you are
not looking, which is what the *notify the agent* switch has always been for.

**Atlarix can now run an automation on demand.** Ask it to try the automation it just set up and
it will fire that one immediately instead of waiting for the schedule, so you find out it works
now rather than tomorrow morning. It behaves like any other command: quick ones report back right
away, slower ones carry on in the background and tell you when they finish. You always get the
result of a run you asked for, even for automations set to notify only you.

- Release plumbing, invisible in the app but the reason the last release shipped with placeholder
  notes: release notes are now written when the release is created rather than edited in
  afterwards, the benchmark CLI publishes without a lookup it was not permitted to make, and the
  action that publishes releases is pinned so it cannot change under us.

## [14.32.0] (2026-08-17) — Scanned PDFs, cancelled commands, and panels that hand things over

**Four things Atlarix quietly got wrong, and three fixes to the browser panels that shipped last
release.** The browser fixes all came from using them; the other four came from auditing a backlog
of ten "worth looking at" items and finding that six of them were already handled.

**A scanned PDF is now readable.** Attached PDFs were always converted to text locally, which works
for a text document and produces *nothing at all* for a scan or a photographed page — the agent
would tell you it couldn't read it. Models that accept documents natively now receive the PDF
itself, so scans, tables and multi-column layouts come through. Everything else is unchanged: if
your model doesn't take documents, the text extraction runs exactly as before. Which models qualify
is read per-model from the live catalog rather than assumed per provider — within a single provider
some models accept documents and some don't.

**Cancelling a command actually stops it.** Every command runs through a shell, so stopping one only
ever signalled the shell — and whatever it had started kept running. Cancel a dev server and the
server stayed up, still holding its port, while the app reported it stopped. The whole process tree
is now taken down, including on quit.

- **A mistyped tool argument no longer wastes a turn.** When a model passed a list where a single
  value was expected, it got an unhelpful internal error. Unambiguous cases are now simply
  understood; genuinely ambiguous ones come back naming the parameter and what was expected, so the
  model can correct itself instead of guessing. This mostly helps smaller and local models.
- **Reading the same page twice in one turn now costs one fetch**, for 15 minutes, and several
  sub-agents reading the same URL at once share a single fetch. Web search already worked this way.
- **Truncated output no longer mangles the last character.** Text cut to fit a budget could split an
  emoji in half, which in the worst case made a request the provider rejected outright.

**A second window could freeze the first one's work.** With two windows open — even on
completely different projects — a background command finishing in one could restart the turn
running in the other, over and over. In the report that found this, one project's turn
restarted 84 times in six minutes, the app beachballed, and the chat filled with empty
responses; closing the second window fixed it. Each restart also killed the turn before it
could finish, so it never recovered on its own.

Every window was listening for *every* chat's background jobs, but each could only see its
own view of what was running — so a window with no knowledge of a chat concluded nothing was
happening there and restarted it. That decision now happens in one place that can see all
windows. Multiple windows, multiple projects and multiple concurrent sessions work as
intended. Pressing **Stop** is also now respected across windows: another window can no
longer resume a chat you just stopped.

**"Always allow" now means it.** If the agent queued several file changes at once, choosing
*Always allow this file* / *this folder* / *this extension* on one of them left all the others
still asking — the rule was saved, but nothing went back for the changes already waiting. It
now clears every queued change the new rule covers, and says how many in one line rather than
another pile of cards. Denials are never applied this way: if you're part-way through a batch,
nothing gets silently rejected.

**Approvals no longer scroll out of sight.** A bar above the message box shows what's waiting
for as long as something is, so a long turn can't bury the approval you're being asked for.
The cards stay in the conversation where the diffs are — *Review* jumps you to them.

**The agent gets better guidance when an edit doesn't apply.** It was being told its text had
to match "exactly, whitespace included" — which was never true, since spacing is already
normalised when matching. That sent it re-typing indentation instead of looking at the real
difference, which in practice was usually content belonging to a similarly-named file. It's now
told what actually went wrong.

**Finding a workspace.** Past five projects the Recent workspaces list gains a search box and
scrolls — searching names *and* paths, so two checkouts of the same repo are still tellable
apart. Below five it's unchanged, since the whole list is already in front of you.

**Reopening a session no longer hijacks the side panel.** It used to jump to the Plan tab and
force the panel open. That guesses you want to resume the plan when you may just be looking
something up — and if the session had several plans, only the newest appeared, presented as
though it were the only one. The plan still loads and the Plan tab now shows a dot, the way
Console and Network do.

**In the browser panels:**

- **Sending Console or Network output adds an attachment, not a wall of text.** It used to paste
  every line straight into your message box on top of whatever you were typing. Anything substantial
  now arrives as a named chip — *Network · github.com · 43 requests* — that you can see, remove, and
  keep while editing the message. Short sends still go inline.
- **One card per page, not per tab.** A tab you'd navigated from YouTube to GitHub showed a single
  card *titled* "github.com" that also contained YouTube's output — and "Send to Atlarix" on it sent
  both. Each page load is now its own card, named after the page that actually produced it, so
  sending one sends only that page. Navigating still clears nothing.
- **The Network tab gained the page boundary it never had.** Console at least drew a divider;
  Network listed every request a tab had ever made in one undifferentiated run.

## [14.31.0] (2026-08-16) — A real Network tab, and the browser stops blocking your turns

**The in-app browser now shows you every request a page made, and it no longer decides on your
behalf that something is broken.** Those two changes are related: the second is what made the first
worth building.

**Nothing the browser sees can end a turn any more.** Until now, a failed request or a console error
in a page could stop the agent from finishing and nag it to fix what it found. The problem is that
Atlarix cannot tell *whose* error it is. A frontend on `:5173` calling its own API on `:8080` is one
app across two origins. A staging URL is the app you are testing. An embedded payment script is
someone else's code until the day it is yours. Every rule we could write is wrong in one direction
or the other — and in practice it went wrong in the expensive direction: the agent opened YouTube
simply to read it, Google's signed-out auth check returned a 401, and the agent was told to go fix a
third-party login handshake. It correctly refused, then spent turns arguing with something that
could not hear it.

So the agent is now **told**, not blocked. One line per turn — counts and where to look, never the
entries themselves — and it reads the detail itself if it decides the detail matters.
**Settings → Browser** controls what it is told: anything recorded (the default), only failures, or
nothing at all.

- **A Network tab.** Every request each browser tab made: method, status, type, duration, and size,
  with headers and response bodies when you expand a row. One scrollable card per tab, so what
  YouTube did and what GitHub did can never be read as the same thing. Bodies are fetched only when
  you ask for one, and if the browser has already discarded it the tab says so rather than showing
  you an empty box.
- **You decide what the agent looks at.** *Send to Atlarix* on a single row, on a whole tab, or on
  everything currently shown — it is added to your message box behind a separator, so it never eats
  what you were already typing. Unread badges on Console and Network tell you something arrived
  without interrupting you.
- **The Console tab groups by browser tab too**, with a divider showing where the page navigated.
  Navigating no longer clears anything: the earlier page's output stays, because comparing two loads
  is often the whole point.

**"Restoring your session…" no longer hangs forever.** If the app started while you were signed out,
that message could sit on screen indefinitely with no way past it — the sign-in broadcast it was
waiting on skipped the signed-out case entirely, so the failure path got no message at all. It now
resolves, with a "Taking longer than usual" note and a sign-in link if it is slow.

**A crash on Linux.** Desktop notifications could take the whole app down — the notification was
released internally while the system was still showing it. Every notification Atlarix sends is now
held until it is genuinely finished.

- **Retries no longer arrive in lockstep.** Reconnect delays were fixed at 2s/5s/10s, so every
  client — and all five of a turn's sub-agents — retried at exactly the same moment. A provider's
  own `Retry-After` still wins.
- **Sub-agents start staggered**, so the first one writes the shared prompt cache and the rest read
  it instead of each paying to write their own.
- For the agent: `browser_inspect(mode:"network")` now shows every request rather than only
  failures, and both console and network reads accept a `tab_id`.
- **File search is repeatable.** Files sharing a modification time — anything checked out or
  generated together — came back in whatever order the directory happened to enumerate in, so two
  identical searches could disagree, and when a result was truncated an arbitrary tie decided which
  files the agent saw at all.

## [14.30.0] (2026-08-11) — On-device dictation works on Windows and Linux

**The free, on-device voice engine now works when your machine falls back to the CPU** —
which, it turns out, was every machine that ever tried. The previous release documented this
as a hardware limitation of "some GPUs". That was wrong twice over.

What actually happened: ONNX Runtime's default graph optimizations crash on Whisper's merged
*int8* decoder, so the CPU path could never build a session **on any platform, including
macOS**. Macs only looked fine because WebGPU works there and the CPU path was never reached.
Windows and Linux machines without usable WebGPU hit it every single time — and, because
nothing could recover from a failed session build, hit it again on every retry and every
restart.

- **The model is now the same 4-bit variant on GPU and CPU.** No int8 anywhere, so the
  crashing optimization never runs. Transcripts are identical to before, and dictation on the
  GPU is marginally *faster* than it was.
- **One download instead of two or three: ~285 MB, once.** Falling back from GPU to CPU used
  to fetch a completely different set of weights, so an affected machine downloaded ~800 MB
  before showing you an error. A fallback now re-downloads nothing.
- **The mic is usable while the model downloads.** It used to be a disabled, spinning icon for
  the entire download — the "it spins forever and I can't do anything" report. You can start
  talking straight away; the transcript arrives once the weights land.
- **The progress figure is now honest**, aggregated across files with megabytes shown, instead
  of jumping around as whichever file reported last.
- **A download that stalls now fails and says so** instead of spinning indefinitely. A blocked
  or black-holed connection produces no error of its own, so nothing could end that wait.
- **Speech recognition no longer needs a CDN at runtime.** The recognition runtime (23.5 MB)
  was fetched from `cdn.jsdelivr.net` on every cold start even though the identical file was
  already inside the app. On a network that blocks or silently drops that host, dictation
  simply never started, with no error. It now loads from inside the app, so it genuinely works
  offline once the model is cached.

If on-device transcription still doesn't work for you, the BYOK engines (OpenAI, Groq, Gemini)
use your own key and are unaffected. Settings → AI → Voice input still has **Clear cache**.

## [14.29.0] (2026-08-10) — Store submission automated, WSL Landlock confinement, sandbox path fixes

- **Automated Microsoft Store submission** — every `v*` tag now submits to the
  Store via the Partner Center Submission API v1. No manual upload needed.
- **`MakerSquirrel.iconUrl`** — Add/Remove Programs shows the Atlarix icon instead
  of the Squirrel default.
- **WSL workspaces use the bundled Landlock helper** when available — no `bwrap`
  install needed in the distro. The helper is shipped from the Linux CI build and
  copied to `/tmp` inside the distro at first use.

**Windows sandbox: two path assumptions corrected.** Both were found by reading the
code after v14.28.0 shipped, not from a user report, and both are Windows-only.

- **Toolchain caches outside `%USERPROFILE%` are now writable.** The sandbox's default
  writable set used one curated list for all three platforms, and it was POSIX-shaped:
  it granted `~/.npm`, but npm on Windows caches to `%LOCALAPPDATA%\npm-cache` and sets
  no `npm_config_cache` for the env-var layer to pick up. Under Low integrity an
  unlabelled directory is simply unwritable, so agent-run `npm install` could not write
  its cache. pnpm, yarn, Go's build cache and Deno had the same gap. Read from
  `%LOCALAPPDATA%`/`%APPDATA%`, so a redirected AppData is followed rather than guessed.
- **`~/Library/Caches` and `~/Library/pnpm` are no longer created on Windows and Linux.**
  They are macOS paths, but sat in the shared list — and missing cache dirs are created
  on every non-darwin platform, so those machines got a macOS-shaped directory in the
  user's home that nothing reads.
- **LocalLow is resolved properly.** The Low-integrity `TEMP` directory was built by
  appending `\AppData\LocalLow` to `%USERPROFILE%`. Windows exposes no environment
  variable for LocalLow, so that was a shortcut around a missing one — and it is wrong
  wherever AppData is redirected (Folder Redirection, roaming profiles). A directory
  created at a guessed path carries no Low label, so the child's `%TEMP%` would be
  unwritable: exactly the "cannot create a temp file" failure the redirection exists to
  prevent. Now uses `SHGetKnownFolderPath(FOLDERID_LocalAppDataLow)`, and a failure to
  resolve or create it exits 87 instead of limping on, so `--probe` catches it and
  commands fall back to unconfined with a warning.

## [14.28.0] (2026-08-07) — Windows commands work again, and Atlarix is on the Microsoft Store

**If you use Atlarix on Windows, agent commands involving git, bash, or most tools in
`C:\Program Files` were failing.** The write-confining sandbox used AppContainer, which
denies *reads* by default — the opposite of what it needed to do. `bash.exe` returned
"Access is denied" and git couldn't open `/dev/null`. It has been rebuilt on Windows'
Mandatory Integrity Control (Low integrity level), which allows reads and execution while
still confining writes to your workspace.

- Sandboxed commands now run in the **same shell** as unsandboxed ones. Previously the
  sandbox forced `cmd.exe` while everything else used Git bash, so POSIX-style commands
  failed with confusing syntax errors.
- **Note:** confining writes this way requires marking your workspace folder with a Low
  integrity label, which persists. This means other low-integrity processes running as you
  (notably sandboxed browser tabs) could write there. Details in
  `src/lib/sandbox/WINDOWS_HELPER.md`.
- If the mechanism can't initialise on your machine, commands run **unconfined** with a
  warning rather than failing.
- Windows workspaces stored inside WSL (`\\wsl$\…`) now run their commands **inside the
  distro**, where the paths and toolchain actually live.

**Linux:** `truncate` was not covered by write confinement — Landlock was pinned to an ABI
predating the `TRUNCATE` right, so `truncate -s 0` on a file outside your workspace
succeeded. Fixed.

**Microsoft Store:** Atlarix now builds as an MSIX package. Store installs keep your
existing workspaces, chats and credentials, and are updated by the Store rather than the
in-app updater.

**Windows and Linux branding:** the Windows installer and app icon were still the upstream
project's logo — `logo.ico` was never regenerated during the rebrand — and deb/rpm shipped
the generic Electron icon. All app icons are now derived from one source.

**Attachments now work for any text file.** File types are recognised from their contents
instead of a fixed list of extensions, so `.mjs`, `.mts`, `.vue`, `.svelte`, `.scss`, `.ps1`,
`.tf`, `.zig`, `.kt` — and files with no extension at all, like `Dockerfile`, `Makefile` and
`LICENSE` — can be attached and read. Previously anything outside a 39-entry list was treated
as an opaque binary blob with no preview.

- **`.ts` files on macOS are fixed.** macOS registers `.ts` as MPEG video, so attaching a
  TypeScript file recorded it as `video/mp2t` and handled it as video.
- **SVG now reaches the model as source.** It was being sent as an image, which vision models
  cannot decode; the markup is far more useful, and `read_attachment` already worked this way.
- Misnamed files are handled correctly too — a JPEG saved as `photo.png` is detected as a JPEG.

**`@file:` mentions now appear as attachments.** Picking a file with `@` showed a chip while
composing, but the sent message rendered the raw `@file:name.txt` text and there was nothing
to preview. It's now a chip you can click to see the file's contents.

**Known limitation — on-device voice input.** The on-device (free) transcription engine does
not work on all hardware. On some GPUs, ONNX Runtime reports
`Can't create a session … Missing required scale` because it cannot execute the 4-bit
operator the quantised model uses — even where WebGPU itself initialises correctly. This is
not new, but it used to present as a mic icon that **span forever**. It now fails visibly
with an error, stops re-downloading ~500 MB on every retry, and can be retried without
restarting the app. Settings → AI → Voice input has a **Clear cache** action for the
downloaded weights. If on-device transcription doesn't work for you, the BYOK engines
(OpenAI, Groq, Gemini) use your own key and are unaffected. Tracked for a proper fix.

> **Superseded — fixed in v14.30.0, and the explanation above is wrong.** It was not the GPU
> and not the 4-bit operator. ONNX Runtime's default graph optimizations crash on Whisper's
> merged *int8* decoder, so the **CPU fallback** could never build a session on any platform —
> including macOS, where it was simply never reached because WebGPU works there. See the
> v14.30.0 notes.

**Other fixes:** the "install Git" message no longer tells Windows and Linux users to run a
macOS-only command; on Windows, Git-for-Windows' bash is now found wherever git is installed
(scoop, chocolatey, portable) instead of only in `%ProgramFiles%`; the dev-server proxy
stopped logging errors about libraries it never shipped (and no longer forces uncompressed
responses).

## [14.27.0] (2026-08-05) — Your credentials and your workspaces stop disappearing

Three things this release stops doing to you, and one it starts.

**Signing out no longer logs you out.** That is not a typo. Two reports —
"I didn't sign out so why does the app log me out when I close it" and "I keep losing all my
api keys" — turned out to be one mistake made in two places: **when the OS keystore was briefly
unavailable, Atlarix read that as "there is no data", and then wrote the emptiness over the real
data.**

An existing session file was skipped and reported as no session at all. That result was cached,
which quietly defeated the retry added in v13.9 for exactly this case — it re-read the cache
instead of the disk, so the fix could never fire. The next save then wrote the blank over your
session. And a session obtained while the keystore was busy was never written at all, which is
the literal "close the app and you're signed out".

Your API keys died the same way: any key that could not be decrypted was dropped from memory,
and because saving worked by read-modify-write, changing your theme was enough to persist the
loss. Unreadable is not absent. Nothing is deleted now because it could not be opened, and the
warning no longer tells you to re-enter keys that are still there.

**Signing out no longer deletes your workspaces.** It ran an unconditional delete of every
workspace — and with them every chat session, MCP server and automation — under a comment
reading "fresh start". Your folders and code were never touched, but everything Atlarix knew
about them was. No comparable tool does this; signing out of Claude Code clears tokens and
leaves your project history alone. The Free plan limit now works the way this product's other
limits already worked: it declines to create a second workspace and tells you why, rather than
deleting the ones you have. If you're above the limit already, you keep everything.

Fixing that turned up three more: a Free user sitting at the one-workspace limit **could not
re-open the workspace they already had**, because the check ran before the "do you already have
this?" lookup; duplicating a workspace skipped the limit entirely; and the workspace count was
cached in a way that only refreshed on delete. Wanting the data gone is now an unchecked box in
the sign-out dialog rather than the default.

**The AI can see your automations.** The feature was substantial and completely invisible to
the agent — it had tables, cron/GitHub/MCP triggers, a runner, pollers and a run feed, and not
one mention anywhere the model could read. So the actor best placed to notice "you've checked
CI by hand three times today" had no idea automations existed.

Now there's one `automations` tool. Listing is free in every mode; creating, changing or
deleting one asks you first, on a card that spells out what a name cannot: that it runs on its
own, whether it will wake the AI, whether it costs a model turn each time it fires, and any
standing MCP consent it grants.

Every automation now has to say **whether it tells the AI** — required, no default, from you
and from the agent alike, and switchable either way afterwards. It is the difference between
"watch CI and act on it" and "watch Slack and let me deal with it": an automation set not to
tell the AI cannot spend a token no matter how often it fires. The agent is told to propose
rather than set things up on its own, and to say which it chose and why.

**The AI knows your plan limits.** It could only discover a cap by hitting one, and nothing
anywhere told it which plan you are on — so "you can't add another MCP server" arrived with no
context and read as something broken. Listing automations or MCP servers now reports the tier,
the count and whether there is room, and the AI is told that a refusal here means remove one or
upgrade, not debug your workspace. Free allows 1 MCP server and 2 automations per workspace; Pro
allows 10 of each.

**Automations got a real editor.** Setting a time meant knowing that `30 14 * * *` puts the
minutes first; there is a scrollable hour / minute / AM-PM picker now. It writes into the cron
rather than replacing it, so anything you could express before still works — and a schedule the
picker can't represent is left alone instead of being quietly flattened.

The GitHub tab is **Pipelines**, and the host is a field you fill in rather than a tab someone
has to add. Atlarix polls the hosts it has support for and tells you which those are when you
type one it can't — an automation that saves and then silently never fires is worse than one
that is refused.

**The AI knows your plan limits, and stops guessing where your workspace is.** It was never told
the absolute path of the folder you have open, yet every command it runs needs one — so it
occasionally invented a plausible path and lost a turn discovering it was wrong. It also learned
the MCP and automation caps only by hitting them, which made a plan limit look like a broken
workspace. Both are now stated plainly, and on Pro it no longer suggests upgrading to a tier that
doesn't exist.

**Start a session by pasting, and it gets a name.** A session whose first message was nothing
but pasted text stayed called "Untitled" — not for a turn, but forever, however long it ran. The
naming step read the pasted attachment, found no words in it, and gave up before looking at the
reply sitting right there; the app then recorded the session as "named" anyway and never asked
again. Both halves are fixed, and it now retries on the next turn instead of getting one chance.

**On Windows, search actually works.** Three bugs, all in how Windows spells a path, and all of
them silent — the assistant was not told it had failed, it was told the wrong answer. **`grep`
found nothing, ever:** a drive letter carries its own colon, so every result ripgrep reported was
discarded while parsing and the assistant was told the code you asked about does not exist.
**`glob` with a full path returned an error** for the same reason in reverse — `C:\proj\...`
became `\C:\proj\...`, a path that cannot exist. And **asking for one folder's contents returned
your entire project**, because the filter that keeps a listing shallow only recognised `/`. macOS
and Linux were never affected, which is exactly why these lasted: they cannot fail on any other
operating system.

**Smaller things you may have noticed.** `@` now leads with your actual files instead of dotted
config folders. An automation the AI creates appears in the panel immediately rather than when
something else happens to refresh it. And a cloud model whose key went missing is labelled with
its real provider — it used to read "(local)" while Atlarix Core quietly answered every message.

**The AI no longer has terminal tabs.** Its commands and their output already appear in chat;
the tabs were a second copy, and keeping them tidy had grown four special-case rules and a
timer. Removing them surfaced three real bugs: reading a background job's output returned nothing
unless you happened to have the Terminal tab open, a request for 50 lines could return 900, and
when the AI asked for output it already had, it was told to look at a list of terminals — a list
that included *your* shells, which it had no business reading. Your own terminal tabs are
untouched, and now genuinely private.

## [14.26.0] (2026-08-05) — One engine for every file lookup, one answer per permission question

Two threads, both about the same habit: keeping a mechanism because it exists rather than
because it earns its place.

**File discovery ran three engines behind one function.** `fd`, then a system `rg` probed on
PATH, then a legacy synchronous walk — and because two of those three ignore `.gitignore`,
they needed a hand-maintained exclusion list to compensate: 26 directory names plus a
64-hex-segment rule for CDK asset dirs, i.e. the layout of whichever project its author had
open. Two things followed. `@`-mention behaved **differently per user** — with `fd` installed
you got gitignored files offered, without it you did not — and the 4,000-path cap applied to
the corpus rather than the results, so on this repo (5,505 files) about 1,500 files could not
be `@`-mentioned however you spelled them.

Now one helper on the **bundled ripgrep** that `grep` and `glob` already use — the single
discovery path that never reached the bundle, because it probed `rg --version` on PATH
instead. `.gitignore` does the excluding. One exclusion survives, `.git/**`, and only because
`--hidden` makes ripgrep list it.

- **`@`-mention is a live query per keystroke** (~15-20 ms, debounced), not a pre-built,
  five-minute-cached, truncated list. Fresher than the cache it replaces, and only the matches
  cross IPC. "Did you mean this path?" gains the most: its whole job is answering a miss a
  rename just caused, and it had been reading a list up to five minutes stale.
- The menu is now **stably sorted** — ripgrep's parallel walkers do not emit a stable order,
  which was invisible behind the cache and would have reshuffled the list mid-type.
- Deleted with the fallbacks: the dead context-files picker chain, `get-chat-logs` (the
  backend of an "Upload Chat Session" button removed in v0.9.20 and orphaned for seven
  months), the whole-repo codebase extractor, and a `files` array that had been hardcoded to
  `[]` and threaded through the entire streaming path. **-2,547 lines net.**

**The permission surface was measured before anything was cut**
(report-only; the document was deleted once acted on, per its own contract — the conclusions
live in `docs/DESIGN_NOTES.md`). Four duplication hypotheses were
tested and **all four refuted** — the layers answer genuinely different questions and each
earns its place. What the audit found instead:

- **`ask` rules in `.atlarix/permissions.json` are gone.** They were compiled, matched,
  returned as a decision, and then written to a log line. Anyone who configured one believed
  they had a gate they did not have. An `ask` key now warns at load instead of being ignored.
- **`interceptor.ts` is 209 lines smaller**, with its pure helpers and its plan-ledger
  bookkeeping moved out and a public method that nothing called deleted. Writing the
  characterization tests first surfaced **two real bugs in command-output truncation**: the
  byte cap silently did not hold (105-byte notice, 80 bytes reserved), and cuts landed
  mid-character on CJK or emoji output, where the replacement character is itself larger than
  the bytes it replaced. Both fixed.

**Workspace hooks are removed** — `.atlarix/hooks/` and its Settings panel. A GUI harness with
an approval queue, committable deny rules and per-workspace permission stores did not earn a
second, shell-executing policy mechanism. The refusal to ever auto-approve a write under
`.atlarix/hooks/` stays regardless.

**Accessibility statement** at [atlarix.dev/accessibility](https://www.atlarix.dev/accessibility),
covering the website and the desktop app. It claims **no** WCAG conformance level, because
nothing has been formally audited, and it names what does not work today — including that the
terminal and side-by-side diffs are hard to convey non-visually, which is unsolved.
