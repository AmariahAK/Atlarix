# Atlarix Changelog — archived releases

**Atlarix 14.25.0** and newer release notes are in [CHANGELOG.md](CHANGELOG.md).

Everything below covers **14.24.0 down through 8.0.x**. Sections are moved here verbatim when the
main changelog grows unwieldy — the release tooling only ever reads the CURRENT version's section
out of `CHANGELOG.md` (`scripts/ci/extract-changelog.sh`), so archiving older ones is safe and does
not touch release notes.

## [14.25.0] (2026-08-04) — The context meter stops lying, and skills stop shouting

Two halves of the same problem: Atlarix pushed content at the model and then misreported
what it had pushed.

**The token popover now counts what the model actually holds.** It was reading each
message's display prose and ignoring `modelContent` — the native tool history, where every
file body, grep hit and command output lives. In a coding session that is most of the
context, so "Message History" undercounted structurally. Two of its five rows (`Codebase`,
`Mentioned files`) were also hardcoded to zero: one a leftover from the retrieval teardown,
the other never wired. The breakdown is now seven rows that partition the real total —
**Conversation, Files read, Search results, Other tool output, Skills & instructions,
System prompt, Current input** — and they sum to it. Tool traffic is carved _out of_
history rather than added on top, because tool results already are history.

- **A staleness bug that fixed itself only on the next message.** The delta cache keyed on
  "highest message id already counted", but an assistant row is pushed when the turn starts
  and mutated as it goes — its `modelContent` is stamped on at finalize. So the first
  mid-stream count froze that row, and the post-stream refetch returned the same number
  because the id had not moved. The newest row is never cached now.
- **"Pruned at last dispatch" showed nothing, ever.** `ContextAssembler`'s budget is
  unbounded (`remaining = Infinity`, no caller can pass one), so its trim report is always
  empty. Actual pruning happens in `pruneContextSectionsForBudget`, which silently blanked
  section content. It now reports what it dropped or trimmed, and the panel says so.

**Skills are an index, not a payload.** Marketplace SKILL.md bodies were pasted into every
dispatch — 10 skills / 6 KB each / 24 KB total, roughly 6k tokens a turn whether or not the
task touched any of them — and repo skills under `.atlarix/skills/` went in whole with no
cap at all. Now one line per skill (name, description, path); the agent reads the file with
`read_file` when a line applies. Cost scales with the _number_ of skills, not their size.

- **Nothing is truncated any more.** `cap()` used to cut a body mid-file, the 11th skill
  vanished without a trace, and even the names summary stopped at 10. A truncated
  instruction is worse than an absent one — the model cannot tell it is reading a fragment.
  Every skill gets an index line, however many there are and however large they get.
- **The index can no longer be outranked.** `installedSkills` had no budget-pruning rule at
  all, so under pressure Atlarix blanked project memory and the session summary while 24 KB
  of skill bodies survived untouched.
- **`compatibleModes: [Debug]` now works.** The frontmatter parser accepted only
  JSON-quoted arrays; bare and single-quoted flow sequences threw, fell through to scalar,
  and left `modes` unset — which the loader reads as "applies in every mode". A Debug-only
  skill silently became a load-everywhere skill, the exact inverse of its author's intent.
- **A pointer that pointed nowhere.** The memory section told the agent the convention lived
  in the `guides/memory` skill, but nothing could resolve that name. Bundled guides are in
  the index now, with a real path.
- MCP was already on-demand (`list_available_mcps` → `mcp_call`, names only in the prompt)
  and is unchanged.

**Writer sub-agents inherit the accuracy base.** A sub-agent gets no AGENTS.md — its whole
system prompt is a small skill file — so the reuse-first ladder and the
never-cut-corners-on-validation rule were missing from the actor most likely to over-build:
narrow scope, no view of what already exists in the codebase. Both now come from one shared
fragment rendered into AGENTS.md and `subagent-writer.md`, so the two copies cannot drift.
The read-only scout is unchanged; it writes no code.

**Atlarix is the Private AI Workstation.** The site's own metadata had said so for a while
whilst every visible line still read "the open-weight frontier harness". Open-weight is
demoted rather than deleted — it remains a true statement about Core's catalog. Privacy is
now stated precisely instead of broadly: your code stays on your machine, nothing indexes
your repo, no embeddings, no file-content telemetry; local models and your own keys reach
only the endpoint you chose; **Atlarix Core routes through our authenticated proxy — not
logged, not retained — to the provider that serves the model, under their data policy.**

- Three claims were wrong as written and are fixed: the FAQ's "nothing is sent to Atlarix
  servers unless you use a cloud model" (Core is the default and does transit the proxy),
  Security's unqualified "processes code locally", and Status's "there is no hosted service
  to go down".
- The analytics consent modal promised "no personal info — anonymous" while Settings
  correctly said signed-in telemetry carries your email and name. The modal now matches.
- **Onboarding:** the first-run wizard leads with the new line and offers **Clone repo…**
  beside **Open folder…** — telling a new user to clone "from the welcome screen" meant
  finishing setup before they could start, the dead end that lost an onboarding review in
  14.24.0.

**The meter is live, and its own arithmetic adds up.** The seven rows sat frozen until a
turn ended — structurally, not for want of a refetch: mid-turn a turn's tool results live
only in main and aren't stamped onto the assistant message until the turn finalizes, so
re-querying returned identical numbers every time. Main now pushes per-tool attribution on
the existing live-usage channel as each step lands, and **Files read** climbs while the
agent is still reading. The card's **Total is now the sum of its rows** rather than the
provider's separately-measured figure, which is why it read 41,492 across seven rows above
a Total of 48,107; the provider's number keeps driving the ring and appears as its own
labelled line.

**"activeSkill (truncated)" was a lie on every single turn.** The flag compared the trimmed
skill text against the untrimmed original, and every mode-skill file ends with a newline —
so it fired always, while the 8,000-token ceiling it reports is never reached by a 3 KB mode
skill. A warning that is always on teaches you to ignore the one time it matters. The
footnote also prints human labels now instead of internal section names.

**Cross-workspace edits.** Reads already reached anywhere; `run_command` writes could
escalate, grant a folder and remember it; but `edit_file` hard-threw at the boundary —
_after_ you had read and approved the diff — telling you to re-import the folder as the
project. The two lanes kept **disjoint grant lists** and never consulted each other. Now
there is one list: grant a folder once, from the approval card or **Settings → Workflow →
Folders outside this workspace**, and it covers both file edits and sandboxed commands.
Grants are per workspace, at directory granularity, and revoking takes effect on the next
write rather than the next session. Every individual change still asks — a grant removes the
outer wall, not the approval.

- A granted folder gives Atlarix **files, not authority**: no project instructions, skills,
  hooks or permission rules are ever loaded from it.
- Deny rules in `.atlarix/permissions.json` match the raw tool argument, so a rule like
  `edit_file(src/**)` will not cover an absolute path in a granted folder — write those as
  absolute globs.

**Security fixes this surfaced.**

- **`.atlarix/hooks/` was blanket auto-approved — live in every prior version, no granted
  folder required.** `hooks.json` is handed to `/bin/sh -c` before and after every tool
  call, so the agent could write itself arbitrary shell with no approval card ever shown.
  The existing carve-out protected `atlarix.md` and `permissions.json` on precisely this
  reasoning and had missed the one directory that executes.
- **Nothing outside the workspace is blanket auto-approved any more,** whatever it is named.
  The `.atlarix/**` allowance matched on a substring, and an outside path renders as `../…`
  — which also meant the agent-memory directory's writes were landing with no card at all.
- **Extension rules no longer reach outside the workspace.** An "always allow `.ts`" granted
  for one project matched any `.ts` file anywhere by extension alone.
- **A cross-folder write can no longer damage in-workspace revert data.** Snapshots stage the
  whole batch in one `git add`, which aborts entirely on an out-of-repo path — so one
  granted-folder file used to silently discard the pre-write snapshot of every in-workspace
  file beside it, and Revert then reported success having restored fewer.

**Build offers a plan when you didn't bring one.** Starting a broad piece of work with no
structure meant the agent free-ran through a dozen files and you only saw the shape at the
end. Build now writes a plan first when a request spans several steps or more than a couple
of files — and explicitly doesn't for a one-line fix. Debug does the same, but only _after_
the hypothesis: planning a bug you haven't diagnosed just commits you to a guess.

**The prompt called Debug mode "Fix".** The mode picker says Debug; the prompt's own label
map said Fix, and the mode header interpolates it — so the shipped prompt read "You are in
Fix mode (the UI labels it Fix…)", asserting something about the UI that was false, and a
user asking to switch to Debug was naming a mode the model had another word for. An earlier
pass had consolidated the prompt's _internal_ copies onto one map without noticing that map
was itself a rival to the UI's. Labels now come from the same function the picker renders,
and a parity test covers every mode.

**A `cd` no longer grants anything.** A model that wrote `cd /some/path &&` had that path
regex-matched out of its own command string and silently added to the session's writable
roots — an invisible, permanent grant derived from text the model produced — and the command
then ran with the OS sandbox switched off entirely. No comparable harness does this: Claude
Code moves the working directory only through the user's `/cd` and grants roots only through
`/add-dir`, opencode raises its `external_directory` permission for outside paths a command
touches, Codex lets its sandbox hold the line wherever the command chdir's to, and Cursor uses
configured workspace roots. Scope now comes only from the explicit folder grants above. A cwd
outside the workspace asks for that folder once, exactly like a cross-repo edit.

- **The sandbox is widened, not dropped.** It still comes off for a genuine installer
  (`brew install`, `sudo`, `npm -g`) whose writes nobody can enumerate — but a command that is
  system-scope _only_ because it touches an outside path now stays sandboxed, with the granted
  folder passed in. An approved `cd` used to mean unrestricted write access to the whole disk.
- **The agent is told a `cd` didn't stick.** Nothing said so, so a model that prefixed one
  carried on believing it had moved and every relative path afterwards resolved somewhere
  else — in one real run it went hunting for the user's project files inside the installed
  application bundle. The command result now states the working directory is unchanged and
  names it. (Claude Code shipped the same fix for the same failure.)
- **Built-in guides are labelled as app-internal.** They are listed with an absolute path
  inside the application so `read_file` can reach them, which is what invited that `cd` in the
  first place; they now sit under their own heading that says they are read-only app resources,
  not part of any project, and never a place to work.

**Looking at a sibling project just works.** `glob({path: "../telios"})` returned a tool
error while the byte-identical absolute path was accepted — reads have always been allowed
anywhere, so the rejection was a spelling rule, not a boundary. An agent asked to take a look
at a neighbouring repo hit the error and then spent `pwd`, `ls ..` and a `find` rediscovering
a path it could have used from the start. `../` now resolves the way the shell would, in
`glob`, `grep` and `read_file` alike. grep in particular used to treat `../sibling` as a
workspace glob and quietly match nothing — a silent wrong answer, worse than the error. A `..`
hidden inside a glob _pattern_ is still refused, an absolute path that lost its leading slash
is still treated as the typo it is, and **writing** to a sibling still requires the folder
grant.

**Mid-task compaction, confirmed.** A long turn that crosses **90%** of the model's real
context window compacts between tool rounds and carries on — measured against the true window
rather than the per-dispatch limit, so a 1M-context model doesn't summarise early. A failing
summarizer is non-fatal by design: the history passes through untouched rather than aborting
the turn. The threshold had been written out three times; it now has one source.

**The app no longer looks like it logs you out and back in on launch.** Since the window
stopped waiting for the session restore — which fixed multi-minute launches on captive-portal
and VPN networks, reported as "the app doesn't open" — the renderer had no way to tell "signed
out" from "not known yet". It mounted with no user, rendered the sign-in screen, and flipped to
the account a few seconds later. Main now reports whether the startup restore has actually
settled, and until it has, the account slot and the welcome screen hold a neutral state instead
of offering to sign you in. Older builds never showed this because they blocked the window
until auth was known; this keeps the instant start and drops the flash.

**Eleven renderer IPC subscriptions were dead.** They were written Electron-style as
`(event, payload)` while the preload bridge forwards only the payload, so `payload` was
always `undefined` and every guard failed silently: streaming phase/status, stream pulse,
live tool-input progress, write previews, partial-reset, models.dev status, fullscreen
changes, plan file sync, autonomous session completion, terminal-instance updates, and
open-workspace-from-CLI. All eleven are fixed, and the bridge's listener type now takes a
single argument so the mistake is a compile error instead of a silent no-op.

**Deleted:** `src/lib/providers/base-provider.ts` (a dead port of a pre-Atlarix Python
agent — an abstract class nobody extended and a system prompt nobody sent; only its `Tool`
type was live, now in the registry), `src/lib/skills/installed-skills.ts`, the orphaned
`skills:get-active-for-session` IPC handler, and the unreachable repo-skill `priority`
branch.

Tests: `token-bucket-attribution` (8), `skill-index-no-bodies` (11), `granted-folders` (11),
`auto-approve-boundaries` (8), `agent-memory-writable` (7), `shared-prompt-fragments` (7),
`ipc-listener-arity` (6), `mode-label-parity` (9), `active-skill-truncation` (5),
`plan-first-nudge` (5), `cd-grants-nothing` (9), `mid-loop-compaction-threshold` (7),
live-bucket cases added to `live-turn-token-usage`, and `priority-skill-mode-match`
rewritten against index lines (12), `sibling-project-reads` (6),
`startup-auth-resolution` (7). Full suite 297 files / 2405 tests green; tsc (app, main,
tests) and oxlint clean.

## [14.24.0] (2026-07-31) — Clone works, and says so when it can't

A reviewer installed Atlarix on a fresh Linux VM, opened **Clone repo**, pasted a public GitHub
URL, typed a workspace name — and the Clone button was disabled with nothing telling them why.
They read it as "this needs a GitHub account", declined to connect one, and stopped testing there.

The button was waiting for a save folder. That folder had no default, and the only way to set one
was to complete a native directory picker; when the picker doesn't open — which happens on some
Linux desktops — nothing happened at all, because a cancelled picker and a broken picker were
handled identically and silently. The URL tab, which is the tab that opens by default, was the one
place in the dialog that never explained itself; the GitHub tab beside it did.

Fixing that meant walking the rest of the clone path, which turned out to be full of the same
class of problem: the code knew what went wrong and said something else. Every failure — private
repo, wrong URL, no network, no git — came back as "Failed to clone repository. Please check the
URL and try again." A GitLab URL was rejected as "Invalid GitHub URL". An SSH URL was quietly
rewritten to HTTPS, discarding the keys that would have authenticated it. And the progress bar sat
at 15% for the entire clone.

The destination is still always your choice — nothing is guessed, nothing is remembered between
clones. It is just no longer possible to get stuck reaching it.

### Fixed

- **The Clone button says why it is unavailable** — "Paste a repository URL to continue" or
  "Choose where to save this repository to continue". Previously the URL tab showed nothing, which
  is what made a missing folder read as a missing GitHub account
  (`src/components/welcome/WelcomeCloneDialog.tsx`).
- **The destination can be typed, not only picked.** "Save to" is now a text field beside the
  picker, validated in the main process (`workspace:validate-parent-dir` — tilde expansion,
  absolute, existing-or-creatable, writable) so a folder that can't be used says why. The flow no
  longer depends on a native dialog that may never open
  (`src/components/welcome/CloneDestinationFields.tsx`, `src/ipc/handlers/atlarix_handlers.ts`).
- **A folder picker that fails to open reports it.** Cancel stays silent, as it should; a failure
  now toasts instead of looking like a no-op (`src/hooks/useGithubCloneFlow.ts`).
- **Clone failures show what git actually said**, mapped to something actionable for the common
  cases — private-or-wrong-URL, SSH key refused, host unreachable, repository missing, git not
  installed — instead of one sentence for all of them. Every path is redacted first: the
  authenticated clone URL embeds the OAuth token and git echoes URLs back in stderr, so the same
  redaction covers the IPC reply _and_ the log file (`src/ipc/handlers/github_handlers.ts`,
  `src/shared/git_remote_url.ts`).
- **A GitHub API hiccup no longer masquerades as a missing repository.** The pre-flight repo check
  turned _any_ `fetch` failure — offline, proxy, rate limit — into "Repository not found or you do
  not have access to it." Only a definitive 404/403 stops the clone now; anything else falls
  through and lets git report the truth.
- **The advice matches the host.** An authentication failure on a non-GitHub remote no longer tells
  you to connect a GitHub account, and an SSH key rejection points at your agent rather than at
  sign-in.
- **A non-GitHub clone is no longer recorded as GitHub-linked.** `githubOrg`/`githubRepo` mean "this
  workspace is linked to a GitHub repo" and build the push URL, so a GitLab clone with them set
  would have pushed to github.com. They are now set for github.com hosts only.
- **The recorded branch is the branch you cloned.** It was hardcoded to `main`, so a repository
  whose default branch is anything else would later push to a branch that may not exist. It now
  comes from `gitCurrentBranch`.
- **Clone progress is real.** The bar reported 5 → 15 → 90 with nothing in between, so a large
  repository looked hung for minutes. `git clone --progress` output is now parsed and mapped across
  the band (`src/ipc/utils/system_git_exec.ts`, `src/ipc/utils/git_utils.ts`).

### Added

- **Clone from any git host.** One shared parser replaces the two GitHub-only regexes, so GitLab,
  Bitbucket and self-hosted URLs clone instead of being refused (`src/shared/git_remote_url.ts`).
- **A transport allowlist on the URL field.** Only `https`, `http`, `ssh` and `git` are accepted.
  `ext::` is refused outright — `git clone 'ext::sh -c "…"'` executes the command, so a URL box
  without a positive allowlist is a command-execution surface — along with `file://` and anything
  starting with `-`, which git would read as a flag.
- **SSH URLs reach git verbatim**, so your own keys authenticate them, with terminal prompts and
  interactive SSH disabled so a clone can never hang waiting for input. Where no git binary exists
  the built-in fallback speaks HTTPS only, and now says so instead of failing obscurely.
- Tests: `clone-url-parse`, `clone-error-surface`, `clone-destination-validation`,
  `renderer/clone-dialog` (44 cases).

### Removed

- `e2e-tests/github-import.spec.ts` — it drove an "Import App" modal with Local Folder / Your
  GitHub Repos / GitHub URL tabs, a UI that no longer exists anywhere in the app.

## [14.23.0] (2026-07-30) — Providers off the hardcode, and a plan that stops arguing with you

Three things in this release share a shape: the app knew something, and then overrode it.

The plan checklist has always had a `blocked` state. It was parsed, it had its own line in the
agent's progress ledger, and the `plan` tool offered it. But the gate that keeps a Build turn going
until the plan is finished counted _anything not `done`_ as unfinished work — so when the agent
correctly marked a step as blocked, the harness told it to carry on with that step, and kept telling
it, up to twelve times in a turn. If a step needed **you** — rotate a key in a dashboard, test on
hardware the agent doesn't have — there was no way to say so and be believed.

Now there is. A step can be marked `external` with a reason, which appears on the step itself so it
survives a reload, and the gate asks only about steps the agent can actually act on. `blocked` also
ends the turn, but it never counts as success: "I'm stuck" and "this one's yours" are different
answers, and collapsing them would let a failing test be reported as done. While fixing this we found
the end-of-turn safety net had been quietly flipping `blocked` steps to `done` on any turn that wrote
a file — turning "I couldn't do this" into "done" without anyone asking.

The second was providers. Twenty were hardcoded, eleven of them as the identical three lines with a
different URL, while models.dev already publishes 172 providers _and_ which SDK each one speaks.
Dispatch now reads that field, so adding a provider no longer needs a release. The hand-written table
that remains holds only what a catalog cannot know — the console link where you actually create a
key, and a handful of deliberate pins where the catalog and shipped behaviour disagree.

The third was sub-agent reports rendering as an unstyled wall of text, because the tool that produces
the richest output in the app had no display branch at all.

### Fixed

- **A plan step that needs you no longer forces the agent to retry it.** New `external` step state
  with a required reason, shown on the step and in the plan card as "N needs you". The completion gate
  now fires only on steps that are `todo` or `in_progress` (`src/lib/tasks/plan-completion-gate.ts`).
- **`blocked` steps are no longer silently marked done.** The end-of-turn safety net closed every step
  that wasn't already `done`, including ones the agent had reported as blocked — so a turn that wrote
  a file converted its own failure into a success. It now closes actionable steps only.
- **Sub-agent results render as markdown** — headings, lists and code, in the card, the dialog and the
  tool result. Previously all four display paths rendered raw preformatted text.
- **Sub-agent reports are no longer truncated to a fragment of internal markup.** The `task` tool had
  no display branch, so its result fell through to a generic ~300-character preview of the raw
  envelope. It now has a real card, with the sub-agent's own error shown on failure instead of
  "Tool failed".
- **Citation footnotes resolve on every reply.** Replies rendered through the non-timeline path were
  built without their citation sources, so inline `[^n]` markers never linked. The same path was also
  missing settled sub-agent rows.
- **A user whose only API key is for a less-common provider is no longer told nothing is configured.**
  The "is any provider set up?" check read a hardcoded list of 21 provider ids instead of the
  providers the app actually offers.
- **Per-provider token budgets appear for every BYOK cloud provider**, not just the 19 that happened
  to be on an allowlist.
- **Stop now actually stops.** Pressing Stop mid-task could restart the agent: the app wakes a new
  turn when detached work reports in, and a stop left that condition true. The revived agent had no
  memory of being stopped — in one report it re-read the file it had just edited, decided _you_ had
  made the change, and pushed to git. Detached work still finishes in the background and its results
  reach you on your next message; the agent just no longer resumes on its own.
- **Revert stays available on a turn you stopped.** The file changes were always saved, but the
  Revert button was hidden unless the turn ended normally — so the turn you most wanted to undo was
  the one you couldn't. (Sub-agent changes revert through the same mechanism.)
- **The agent no longer mistakes its own edit for yours.** After a failed match it was told "the file
  likely changed since you read it" even when it had edited that file seconds earlier, which is how it
  came to believe a fix was already made and act on it. It now says plainly that the content didn't
  match, and shows what's actually there.
- **A whole-file overwrite requires having read the file first.** Replacing a file wholesale discards
  everything in it, and nothing else catches an overwrite based on a stale copy. Surgical edits are
  unaffected — those already fail safely when your copy is out of date. Creating a new file is unaffected.
- **Project instructions in `.atlarix/atlarix.md` no longer stop applying past 3000 characters.**
  The file was pasted into every request and clamped there, so on a longer file the rules in the tail
  were silently dropped — with nothing shown to you or to the model. Instructions are now referenced
  (with their section list) and read in full when they matter.
- **Atlarix Core credits are no longer given away by a misconfigured model.** A Core tier whose price
  entry resolved to zero billed nothing at all, silently, on every call. It now charges and names the
  tier that needs fixing.
- **Your account appears as soon as the window does.** Signed-in state was rendered only after a
  token refresh that can spend seconds retrying, so a signed-in user saw a signed-out app first.
- **"Reset everything" leaves the app usable.** It closed the database and deleted the file but kept
  running, so everything afterwards failed until you restarted. It also left the write-ahead log
  behind, which could restore rows you had just deleted.
- The Tools page no longer advertises four Core models when fewer are configured, a Permissions panel
  that approvals moved out of in 14.15.0, or two features that were removed.
- **"Always allow" now works on every file.** Certain paths — workflows, `package.json`, lockfiles,
  `.env` — were hardcoded to ask again on every single edit with no way to opt out, so editing a
  GitHub workflow meant approving it forever. Every write still shows you the diff first, and a
  "never allow" choice is still respected; you can just make the decision once now.
- **Stray text like `","progress":"0/14 steps done` no longer appears in replies.** A fragment of the
  plan tool's internal result could render as chat text.
- **Code blocks containing JSON are no longer mangled.** A fenced `json` example that mentioned certain
  internal field names could have its contents silently deleted.
- **Sub-agent panels no longer make the page jump.** The panel folded up the instant the last sub-agent
  finished — often while the reply was still being written — which shifted everything below it. It now
  folds once the turn is done.

### Changed

- **Providers are read from the models.dev catalog rather than hardcoded.** Dispatch keys on the
  catalog's `npm` field via `src/ipc/shared/provider-sdk-factories.ts`; `get_model_client.ts` drops
  from 24 provider cases to 13. Providers needing more than a URL and a key — Core, Vertex, Azure,
  Bedrock, Cohere, Elastic, OpenRouter and the local runtimes — stay explicit.
- **API keys are found under any of a provider's documented env vars**, in preference order, instead
  of one name per provider. (Google publishes three; the catalog's first is not the one its SDK
  reads.)
- **`preview_test` is now `browser_test`** — it drives a browser tab, and "preview" referred to a pane
  removed in 14.15.0. The old name still works and needs no action from you.
- Providers with a dedicated `/models` endpoint now list live models even without a bespoke fetcher,
  so newly released models appear ahead of the hourly catalog refresh.
- **Project memory is now one file per fact, kept outside your repo.** A single `.atlarix/memory.md`
  was added to every request in full, so the more the agent learned the more each unrelated message
  cost — on Core models that is paid every turn. Notes now live in `~/.atlarix/projects/<project>/`
  and only a one-line index is carried, so twenty notes cost about as much as one. They're
  per-developer and never committed, and an existing `.atlarix/memory.md` is migrated on first use
  (the original is left alone).
- Saving a note is **suggested, never required**, and never interrupts what you asked for. Set
  `ATLARIX_MEMORY=off` to disable it entirely; benchmark runs disable it automatically.
- **Sub-agent results fold away when they finish.** A completed round collapses to one line with the
  reports a click away — during the run nothing changes. Their summaries are written for the agent,
  not for you, and shouldn't sit between you and the answer.

### Internal

- `AssistantMessageBody`'s two render branches now share one trailing component, with a parity test
  across all three branch configurations — this class of bug had shipped four times.
- Registry tools can declare `aliases`, so a rename keeps working for saved sessions without spending
  prompt budget on the old name.
- Report-only prompt-surface audit (acted on, then removed in 14.26.0). Finding: sub-agents
  spawned by name get a much shorter system prompt than un-named ones, and the guidance steers callers
  toward the named form.
- Project instructions had **two** injection sites (the context section and the base prompt's
  instruction layers), so the file was added to every request twice. Both are now the one pointer.
- Memory isolation between projects is structural rather than filtered: the directory name is the
  workspace path plus a hash, because slugifying alone collapses `/a/b-c` and `/a/b/c` into one name.

## [14.22.0] (2026-07-28) — Edits that don't corrupt files, and a harness that tells you the truth

This release started with one bad edit. A model sent `old_content` and `new_content` carrying
backslash-escaped quotes; the match cascade un-escaped the _find_ side to locate the code, then
wrote the _replacement_ through verbatim — putting literal `\"` inside Go raw-string literals,
which cannot contain escapes. The file stopped compiling. The agent was then told the match had
succeeded "with indent/EOL tolerance", which was the wrong explanation, so it spent the next
twenty-five turns looking at whitespace and encoding while the real cause sat in plain sight.

Both halves of that are fixed, and the audit that followed found the same shape elsewhere: a
signal that outlives the thing it describes, or describes it wrongly. A background job's
countdown pinging after the job finished. A workspace stuck on "Folder not found" after the
folder came back. A run that reported "Successfully executed" beside a non-zero exit code.

The prompt got the same treatment. Guidance that belonged on a tool moved onto the tool, where
it costs nothing on turns that don't use it, and mode rules that were being restated four times
per turn are now stated twice. The Build-mode header is 28.9% smaller with no rule removed.

### Fixed

- **`edit_file` no longer writes escapes into your files.** Whatever normalization let the
  match succeed is now applied to the replacement too, so an escape-normalized match
  un-escapes both sides (`src/lib/tools/edit.ts`). This is the corruption described above.
- **Edit notices name the strategy that actually matched** — "escape-normalized", "block-anchor",
  "indentation" — instead of always claiming indent/EOL tolerance. The strategy was already
  known and was being discarded (`src/lib/tools/edit-match.ts` → `src/lib/tools/edit.ts`).
- **A guessed match faces a human.** A fuzzy (non-exact) `edit_file` match no longer
  auto-executes, whatever the auto-approve setting says
  (`src/ipc/handlers/chat_stream/permission-ui.ts`). Headless runs are unaffected — their
  approver resolves it.
- **Plan results no longer leak JSON into replies.** `update_step` and `set_status` returned a
  shape the reply sanitizer didn't recognise, and a truncated echo was emitted verbatim, so
  fragments like `","progress":"0/5 steps don` reached the chat
  (`src/lib/chat/answer-display.ts`, `src/lib/tools/plan.ts`).
- **A session started by pasting gets a name.** When the first message was nothing but an
  attachment it stripped to an empty string, which was both the title model's input and what
  the fallback was gated on — so both starved and the session stayed "Untitled" forever
  (`src/ipc/handlers/workspace_session_handlers.ts`).
- **A workspace whose folder comes back is usable again without restarting.** Only the positive
  existence check is cached now, so a re-cloned repo recovers on its own; the macOS
  folder-access prompt is still asked at most once per existing workspace
  (`src/ipc/utils/workspace_path_status_broadcast.ts`).
- **A finished background job stops asking to be re-checked.** A countdown that had already
  fired left a queued nudge with no job association, so nothing could remove it when the job
  completed (`src/lib/agent/scheduled-wakeups.ts`).
- **`run_command` no longer reports "Successfully executed" next to a non-zero exit code**
  (`src/ipc/handlers/chat_stream/turn-runner/build-branch.ts`).
- **`BrowserWindow.getFocusedWindow` is stubbed for non-Electron runs.** `getPrimaryWindow()`
  calls it on the chat-stream path, so a headless run reaching that path threw
  (`src/headless/electron-stub.ts`, `vitest.setup.ts`).

### Changed

- **Parameter aliases are absorbed instead of prompted against.** `file_path`, `filePath`,
  `filename` and `file` are accepted wherever a schema declares `path`, canonicalised before
  validation (`src/lib/tools/guard.ts`). The standing prompt clause telling the model our name
  is `path` is gone — it cost tokens every turn and still missed.
- **Tool guidance moved onto the tools.** The browser block (1,872 chars, rendered in four of
  five modes) now lives on the seven browser tools; git _policy_ lives on `run_command`; web
  research rules live on `web_search` / `read_url`. Tool descriptions are conditional, so a
  turn that doesn't use a tool no longer pays for its guidance.
- **Mode rules are stated twice, not four times.** `<work_mode>` is gone for Explore, Build,
  Fix and Review — their limits are enforced by the toolset and sandbox — and survives for
  Plan, the one mode that is a workflow rather than a permission set
  (`src/lib/tools/mode-prompt-bundle.ts`).
- **Six prompt/harness contradictions fixed.** Plan mode advertised `run_command` and
  `edit_file`, neither of which it has; browser guidance was suppressed for Plan although it
  has all six browser tools; `preview_test` was recommended to read-only modes; and the debug
  mode's label read "Fix" in the UI and "Debug" in the prompt _in the same render_. Mode labels
  now derive from the registry so they cannot diverge again.
- **`edit_file`'s description carries the contract and preconditions only.** The failure
  taxonomy is delivered by the result channel, which already reports the actual near-miss with
  line numbers and the exact range to re-read.
- **Sub-agents are addressed by name first**, with the task id as the fallback, and the
  ambiguity error now suggests a longer name rather than an id (`src/lib/tools/subagents.ts`).

### Added

- **A standing test that no mode's prompt names a tool that mode cannot call**
  (`src/__tests__/mode_system_consistency.test.ts`). This is what caught three of the six
  contradictions above, and it prevents the class recurring.
- **A `plan` card** — title, status, `N/M steps done`, and the checklist, with an honest count
  of steps the preview cut off. `plan` previously had no card at all and rendered worse than
  any other tool despite having the best structured data (`src/lib/chat/tool-expand-view.ts`).

### Notes

- The suite was red before this work for reasons unrelated to it: 36 tests across 23 eval files
  failed on a missing `BrowserWindow.getFocusedWindow`, and one assertion still expected
  `target:"preview"` from the Preview tab deleted in v14.15.0. Both fixed; 2043 tests pass.
- `npm run package` currently needs `npm_config_registry=https://registry.npmjs.org/` on a
  machine with a custom global registry — `packageAfterPrune` spawns npm outside the project,
  where the project `.npmrc` does not apply. The one-line `forge.config.ts` fix is deferred.

## [14.21.0] (2026-07-27) — Sub-agents you can see, and changes you review before they land

This release covers four versions of work (14.18 through 14.21) that hadn't shipped yet.

The headline is how delegated work now behaves. When the agent hands a coding job to a
sub-agent, that sub-agent no longer writes anything: its edits come back as a proposal per
file, and the main agent reads each diff and decides. Accepting writes the sub-agent's exact
work — nothing is retyped along the way — and a file that isn't already on your allow-list
still asks you, exactly as it would for any other edit.

Sub-agents are also visible now. A long one moves to the background on its own instead of
holding the turn, and the running-tasks chip lists them alongside background commands, so you
can watch progress or stop one without waiting.

### Added

- **Delegated code changes are reviewed before they land.** Previously a sub-agent worked in a
  hidden copy of your project and handed back one big diff, truncated if it was long. Now each
  file arrives separately with its own diff. If two sub-agents changed different parts of the
  same file, both can be accepted; if they changed the _same_ lines, that is flagged as a
  conflict rather than silently resolved.
- **If a file changes while a proposal is waiting**, the change is re-fitted onto your newer
  version when it still fits, and refused with an explanation when it doesn't — it will not
  overwrite work you did in the meantime.
- **Sub-agents appear in the running-tasks chip**, with elapsed time, live progress you can
  expand, and a stop button. They were previously invisible there and could only be stopped
  from inside the agent's own turn.
- **A sub-agent taking more than 30 seconds moves to the background automatically**, so the
  turn keeps going. A foreground sub-agent previously had no time limit at all, which is why
  one occasionally looked stuck. One that goes quiet for a long time now nudges the agent
  instead of stalling silently.
- **Sub-agents can be referred to by name**, not just an id — the same as background jobs.
- **Delegated work in Plan mode** can now fan out across subsystems and web research instead
  of being limited to a single helper.
- **Each window is its own workspace.** Windows are named after the project they have open,
  and a window's browser tabs, terminal tabs, and plan cards belong to that window alone —
  they no longer leak into another one.
- **The agent can send a command to a named terminal tab** and read one back, instead of
  opening a new tab each time.

### Changed

- **Writer sub-agents no longer need a git repository.** In a project that isn't tracked by
  git they previously ran read-only without saying so clearly. They also see files git
  ignores, which they could not before.
- **Fewer, clearer tools.** `terminal_read`/`terminal_list` folded back into background jobs;
  listing and stopping sub-agents moved to its own tool.
- **Automations lost the "worktree writes" mode.** Existing automations set to it become
  read-only runs. Nothing else about automations changes.
- **The disk space a removed feature left behind is reclaimed on first launch.**

### Fixed

- **Background work no longer dies with "Core has an issue."** Resuming a turn after a
  background task finished could fail outright on some models.
- **Older messages are no longer silently deleted from a long conversation.** The turn history
  was being trimmed without telling you or the model; now it isn't trimmed, and the model is
  told its actual context size rather than guessing.
- **A long session no longer breaks partway through** because the sign-in token used for
  Atlarix Core had gone stale mid-stream.
- **A 1,000-line edit no longer freezes the app for several seconds.** The diff is now
  computed before it reaches the screen, and a very large one starts collapsed with a summary.
- **The token counter survives a restart** and updates when you switch work mode.
- **A plan step that fails to tick is now recorded**, and a plan can no longer be marked
  complete when it never started — the cause of a spurious "18/18".
- **Renaming a session by editing your first message now works**; a name you typed yourself is
  still never overwritten.

## [14.17.1] (2026-07-26) — Answers that stream instead of arriving all at once

### Fixed

- **A fast model now streams its answer instead of just appearing.** Some providers reply
  quickly enough that the whole answer landed in one step — the text never streamed, and the
  view jumped to the bottom in a single jolt. Replies are now revealed at a steady rate, so
  reading one feels the same whichever model you picked. Models that were already comfortable
  to read are untouched: the limit only applies to output arriving faster than that, so
  nothing has been slowed down to achieve it. If you have reduced motion enabled, text
  appears immediately as before.
- **A custom credit top-up below the $10 minimum is now refused as you enter it**, with the
  reason, instead of being added to your running total and then rejected at checkout.
- **The app is much quieter on the network while idle.** A one-time account setup step was
  being re-requested on every session check, once for each part of the app that asks who you
  are — dozens of identical requests for something that can only happen once. Requests that
  overlap are now answered together. Nothing about your balance or plan is cached, so a
  top-up still shows up straight away.

## [14.17.0] (2026-07-26) — Atlarix Core talks to the model makers directly

Core used to reach every managed model through OpenRouter. It now calls the provider APIs
directly, which is why the model list is shorter and sharper: **GLM 5.2** and **DeepSeek V4
Pro**, both with a one-million-token context. One prepaid balance still covers all of them —
you are billed what a reply actually costs on the model you used, so switching mid-conversation
is fine.

### Fixed

- **Your answer no longer ends up inside the "Thoughts" card.** Every model that wraps its
  reasoning in `<think>` tags — DeepSeek included — was having the visible reply captured as
  part of its thinking, so reasoning and answer appeared mixed together. A reply that _opened_
  with reasoning could vanish entirely. Four separate places normalised those tags the same
  wrong way; they now share one implementation, so they cannot drift apart again.
- **A stray `</think>` no longer appears in the middle of a reply.** Some models send the
  closing tag on its own; it had nothing to match against and was rendered as text.
- **Atlarix Core now knows how big its models really are.** Core was reading its context window
  from the wrong catalog and falling back to 128K — so a million-token model was being compacted
  at roughly an eighth of its real capacity, throwing away context that never needed to go.
  DeepSeek on Core now resolves its true ~1M window.
- **Thinking settings reach the model in the shape it actually accepts.** Reasoning options were
  picked per _provider_, so every model from a given provider got the same request — which is why
  MiniMax M3's thinking behaved oddly while its sibling looked fine. Each model's own declared
  capability is now used, and a model is never sent an effort level it does not support.
- **Models that reject a `temperature` setting are no longer sent one** (Kimi K3 among them).
- **Citations link to pages, not to raw source files.** Web search kept surfacing code files,
  which crowded out the articles and docs that answered the question. The citation preview also
  showed a blank panel; it now shows the search excerpt, with buttons to open the page in
  Atlarix's own browser tab or externally.
- **Discord profile pictures load**, and the account badge says Discord instead of GitHub.

### Added

- **The token meter names what background work spent your tokens.** Sub-agents and context
  compaction were shown as a single figure labelled "Sub-agents", so work the app did on your
  behalf looked like work you had asked for. Each source is now listed separately with its call
  count.
- **The agent knows where it is on a page.** Reading a page now reports scroll position, so it
  scrolls to find content that only loads further down instead of concluding it is absent.
- **The Core model list follows the catalog.** Atlarix can run two, three or four Core models and
  the picker shows exactly what is configured — no placeholder rows for slots that are empty.

### Changed

- **Core web search now uses the built-in search tool and the in-app browser.** OpenRouter's
  server-side search is not available to Core any more, and none of the direct providers offers an
  equivalent over a plain chat endpoint. A dedicated search integration is planned.
- **A Core model that is temporarily unavailable says so plainly** and points you at the other
  Core models or your own API key, rather than implying all of Core is down.

## [14.16.1] (2026-07-23) — Staying signed in, and seeing your models straight away

### Fixed

- **You stay signed in across restarts.** v14.16.0 moved the startup session restore to _after_ the
  window appears — the change that stopped the app hanging for minutes on a bad network. The
  renderer therefore starts signed-out and is corrected once the session lands, but the handler
  receiving that correction could only ever _update_ an existing signed-in state, never establish
  one. So the correction was dropped and you were asked to sign in again, with a perfectly valid
  session sitting in the app the whole time. It now re-reads the session from the main process
  rather than trusting the notification, which carries plan details but no identity. A second fault
  with the same effect is fixed too: the user's identity was only recorded _after_ their plan had
  been looked up, so a failed lookup — exactly what happens offline — discarded the session.
- **A provider's models appear the moment you save its API key.** Model lists are cached for five
  minutes and were only refreshed by a few specific events; saving a key wasn't one of them. Add a
  key and the model picker kept showing the list from before it existed, so a provider you'd just
  set up looked missing — and deleting a key left its models behind. Fixed at the single point every
  provider form writes through, so it holds for every provider and any added later. **No keys were
  ever lost — only the display was stale.**
- **Onboarding text** no longer refers to Blueprint and Code-to-Canvas, both removed some releases ago.

### Added

- **Sign in with Discord**, alongside Google and GitHub. If an account doesn't share a verified
  email address, sign-in now stops with an explanation instead of creating a half-account that can't
  be plan-checked or billed.
- **Settings → Community** — join the Discord, review Atlarix on PeerPush, and a one-time
  "where did you hear about Atlarix?" question. The download of an installer carries no trace of the
  post, video or person that sent you here, so it's the one thing analytics genuinely cannot answer.
  Asked at most once per account, skippable, and always available in Settings if you'd rather answer
  later. It respects the analytics opt-out.

## [14.16.0] (2026-07-23) — Multi-tab browser agent, the app opens offline, model lists that can't shrink

Four strands that all come down to the same thing: the app should keep working when the world
around it doesn't cooperate — no network, a background tab, a provider returning a truncated list.

- **The browser agent grew the ergonomics it was missing** — several tabs at once, find-an-element
  by description, and the ability to press a key, hover, or scroll. It could not previously press
  Enter.
- **The app opens without a network**, in the time it takes to draw a window.
- **The models.dev catalog is now the floor** under every provider, so a truncated `/models`
  response can no longer make models disappear from the picker.
- **Dictation, voice settings and analytics identity** corrected.

### Added

- **The browser agent can keep several pages open.** New `browser_tabs`
  (`list`/`create`/`switch`/`close`) exposes the tab lifecycle that already existed for the UI.
  Previously every navigation reused the one tab, so opening a second page destroyed the first
  one's state — a signed-in session, a scroll position, a half-filled form. `tab_id` threads
  through the other browser tools; the panel follows the agent, like a real browser.
- **`browser_find`** — locate an element by describing it ("login button", "search box") instead of
  reading the whole page first. Ranked heuristically **in the page** on role, accessible name and
  text: no model call, so it's deterministic, free and instant. Capped at 20 matches, and it says
  when there are more rather than truncating silently.
- **`browser_interact` gained `key`, `hover` and `scroll`**, plus typed `fill`. The agent could not
  previously **press Enter** — no submitting a search box, no Escape to close a modal, no Tab between
  fields — and could not open a `:hover` menu or reach lazy-loaded content. `fill` now takes a boolean
  for checkboxes and matches a `<select>` option by value **or visible text**, which removes the
  value-vs-label mismatch that used to make a fill silently no-op.
- **`browser_batch`** — run several predictable steps in one call (fill, fill, press Enter). Sequential,
  halts on the first failure, refs only. `preview_test` keeps its own asserted pass/fail path.
- **One-call page read.** `browser_inspect` with no mode now returns page content _and_ interactive
  refs together, so reading a page in order to act on it is one call rather than two plus a choice the
  model regularly got wrong. `filter:"interactive"` narrows to controls. Nothing was removed —
  `snapshot`, `text`, `visual`, `design`, `console` and `screenshot` all still work.
- **`browser_inspect` mode `"network"`** surfaces the failed (4xx/5xx) requests the page made.

### Changed

- **The agent's cursor is visible while it works.** A pointer now glides to each target and stays on
  screen between actions, with a ring on the target and a chip naming what it did ("click", "type",
  "Enter", "hover", "scroll down"). Previously only clicks and fills drew anything, and only for
  600ms — so pressing a key, hovering a menu or scrolling was completely invisible.
- **The Browser panel opens the way the Plan panel does.** When the agent needs the browser it asks
  the UI to open the right panel on its Browser tab, honouring your auto-open preference — instead
  of the main process making the page visible on its own, which drew a bare browser over half the
  window with no tab strip or URL bar. Only navigating and opening a tab ask; switching tabs and
  reading never do, so a panel you deliberately closed stays closed and the tools keep working.

### Removed

- **Browser session recordings (the frame-by-frame replay).** It wrote ~55 KB JPEG per action (up to
  150 per turn) into `userData/media`, and it was the only reason the fragile off-screen capture
  path existed. Watching the agent live is now better served by the visible cursor and the panel
  following along, and the **ordered text record of what it did is kept** — that one is written at
  the moment of each action, so unlike a screenshot it can never show a stale page. Screenshots on
  demand (`browser_inspect(mode:"screenshot")`) are unaffected.

### Fixed

- **Screenshots work with the Browser panel closed.** Detached tabs are captured via a hidden paint
  surface. The old path parked the view at `x:-20000`, which never produced a frame: a view whose
  rect doesn't intersect its window has no compositor surface. It appeared to work only because a
  tab that had been on screen still held its last painted frame.
- **Element refs no longer shift under the agent.** Refs were reassigned by DOM walk order on _every_
  read, so a node inserted near the top of the page silently renumbered everything after it — `e7`
  became a different element and a click landed on the wrong thing. Refs are now held in a `WeakMap`
  in the page realm, keyed on the element itself, so a ref means the same element for the life of the
  document and resets on navigation. Verified against a live page: a button kept its ref across an
  insertion that previously would have moved it.
- **A read could be answered from a zero-width layout.** A `WebContentsView` whose bounds don't
  intersect the window gets a 0×0 viewport — the document still lays out, at zero width, so
  `visual`/`design` results were plausible and wrong rather than obviously broken. Reachable because
  the first agent navigation attached the tab before the renderer had reported panel bounds. Tabs now
  attach with a sane fallback size, and a zero-width read is refused instead of answered.
- **Reads disclose the viewport they were measured at.** The browser panel is resizable, so the agent
  was judging pages at whatever width the panel happened to be — a page read in a narrow panel is the
  mobile layout, with nothing in the result saying so.
- **Truncated reads report the real total.** "capped at 200" told the model the cap, not that it was
  missing 1,140 elements, so a truncated read looked complete. It now says "showing 200 of 1,340".

- **The app no longer hangs at launch without a network.** `restoreAuthSessionOnStartup()` and
  `SubscriptionManager.initialize()` both ran **before** `createWindow()`, both hit Supabase, and
  neither was timeboxed — the surrounding `try/catch` caught nothing useful, because _a hang is not an
  exception_. Cleanly offline was survivable (DNS fails fast), but on a black-hole network (captive
  portal, hotel wifi, VPN) every request hung to the OS TCP timeout (~75s on macOS) and the session
  refresh retried three times: **minutes with no window at all**, which reads as "the app won't open".
  Both now run as background work after the window exists, and the renderer is corrected over the
  existing `plan-changed` channel once the session resolves. **Startup now costs the same online and
  offline.**
- **Every Supabase request has a deadline.** supabase-js sets no default request timeout, so the same
  hang could hit sign-in, plan refresh, and the hourly token refresh mid-session. An 8s per-request
  ceiling (composed with any caller signal) makes all the existing `catch → degrade` handling actually
  reachable. Realtime websockets are untouched.
- **Offline Pro users are no longer silently downgraded to Free.** `getUserPlan` returned `'free'` on
  any error and the tier cache was in-memory only, so launching without a network cost a paying user
  their plan — workspace and automation limits included — for the whole session. The server-confirmed
  plan is now persisted and honoured **until `subscription_ends_at` passes**, scoped to that user id
  and cleared on sign-out. A reachable server always wins; this is a fallback, never a cache-first
  path. A record with no end date is deliberately **not** honoured — absence of a boundary must never
  grant an unbounded entitlement.

### Dictation accuracy, voice settings, analytics correctness

#### Fixed

- **Dictation is materially more accurate.** Four compounding causes, all fixed:
  the on-device model was `whisper-base` (74M — "roughly the right words" is its signature) and is now
  `whisper-small`; mic capture ran with the browser's call-tuned DSP (`noiseSuppression` and
  `autoGainControl` default to ON under `{ audio: true }`, and both hurt ASR) and now requests them
  off at mono 16 kHz; the spoken language was **never passed**, so Whisper re-ran language _detection_
  on every clip, and it now resolves from a new setting or the OS locale; decoding was greedy and now
  uses 4-way beam search. First on-device use downloads ~409 MB instead of ~206 MB, cached permanently.
- **Voice settings are findable.** The transcription engine, spoken language, and dictate/live mode now
  appear under **Settings → AI**; previously the engine could only be changed from the composer's
  config dropdown, so BYOK voice was effectively hidden. Both surfaces share one setting.
- **Settings → Team removed** — a dead sidebar entry left behind by the pricing reframe. It matched no
  section, so clicking it did nothing.
- **PII no longer sent to analytics.** The extra-files events transmitted an array of **absolute file
  paths**, leaking project structure and usually the OS username. They now send a count.

#### Changed — analytics (breaking for existing PostHog insights)

- **Analytics identity is now the account, not the install.** A per-install anonymous UUID was never
  linked to the Supabase user, so one person on two machines was two people and a reinstall minted a
  third — inflating every per-user number, retention worst of all. Sign-in now sends `alias`
  (anonymous → user id, once per install) and attributes everything after to the user id, in both
  main and renderer. Person properties carry plan/tier — and, since a later owner decision,
  your email and name when signed in, so usage counts once across devices. _(Corrected
  2026-09-01: this line originally read "never email, name, or avatar", which the code
  already contradicted. See v14.39.1.)_
- **`persistence` changed from `memory` to `localStorage+cookie`** so `$session_id` survives a restart;
  session-scoped metrics were previously meaningless. _(Corrected 2026-09-01: consent gating
  was NOT unchanged in effect — persisting meant `init` wrote a distinct id to localStorage
  and a cookie before consent existed. Fixed in v14.39.1 by gating initialisation.)_
- **Events renamed to one convention** (three coexisted): `compass:turn_completed`/`_failed` →
  `core_turn_completed`/`core_turn_failed`, `app:initial-load` → `app_ui_ready`,
  `auth:chat_stream_blocked` → `auth_chat_stream_blocked`, `action:*` → `action_*`, `extra-files:*` →
  `extra_files_*`. **Insights built on the old names stop populating and must be rebuilt.**
- **`app_launched` removed** — a duplicate of `app_opened` fired six lines later, double-counting every
  launch. `arch` folded into `app_opened`.
- **Added** `active_day` (once per calendar day — retention was previously only inferable from
  incidental event presence) and a `duration_bucket` on `task_completed`. `workspace_opened` gained
  `exists`/`is_git_repo`; `model_connected` now also fires for local runtimes (`type: "local"`), which
  need no API key and so never entered the activation funnel at all.
- Consent copy updated to state the account link, and to name file names/contents explicitly as
  never-sent.
- **Pre-alias person counts are not comparable to post-alias ones.**

### models.dev catalog as the floor for every provider

Model lists stop going missing. The models.dev catalog is now the base list every cloud provider
stands on, and a provider's own `/models` endpoint is a best-effort overlay that can only **add**
models or refine fields — never remove them.

#### Fixed

- **Truncated provider responses can no longer empty the picker.** Anthropic's `/models` paginates at
  20, Google's at 50, Cohere's at 20 — each returned a partial list at HTTP 200, and because the old
  code only consulted the catalog when native fetch _threw_, the fallback never fired and models
  silently vanished while the correct list sat in memory. Bedrock listed zero for the mirror reason.
  New `mergeByApiName` (`src/lib/models/merge-provider-models.ts`) unions catalog + native, so the
  worst case is now "a new model shows up an hour late" instead of "models are invisible".
  `src/ipc/shared/language_model_helpers.ts`.
- **Offline first run no longer shows an empty provider list.** With no disk cache and no network the
  catalog resolved to `{}`. A build-time snapshot (`build/models-snapshot.json.gz`, ~300 KB gzipped,
  shipped via `extraResource`) is now the last tier: memory → disk cache → bundled snapshot → network.
  Regenerate with `npm run models:snapshot`.
- **Catalog cache writes are atomic.** `saveToCache` wrote directly over the live file, so the
  disk-full failure behind Sentry `49d4f2a5` truncated it and the next boot lost all 169 providers.
  Now temp file + `rename`, with temp cleanup on failure.
- **Transient fetch failures retry.** 2 retries with exponential backoff + jitter; an abort (the 30s
  timeout) is deliberately not retried. The boot fetch is skipped when the cache is under 5 minutes
  old, so launch-quit-launch stops re-downloading the catalog.

#### Removed

- **Five bespoke native fetchers** — `cohere`, `mistral`, `xai`, `together`, `groq` — plus the
  `nvidia_nim` / `cerebras` / `huggingface` wrappers. Each produced a strict subset of catalog rows
  with worse display names, and between them accounted for every recent "models missing" bug. All
  eight providers still list in full from the catalog. Kept: `openai`, `anthropic`, `google`,
  `openrouter` (live pricing + `top_provider` ceilings), the open-weight four (Core tiers, ship
  weekly), and `elastic` (lists Kibana agents — genuinely absent from models.dev).

#### Changed

- A provider whose `/models` is entitlement-scoped (OpenAI gates some models by org tier) may now list
  a model the key can't call, which 403s at call time. Deliberate: a visible error beats a silently
  missing model, and it matches how the ~145 catalog-only providers already behaved.

## [14.15.0] (2026-07-21) — Browser-first workflow, richer error capture, universal sandbox write-escalation

`npm run check` 0/0, vitest green.

The **Preview tab is gone** — the app you build now runs in a regular Browser tab like any other URL, so there is one surface to learn instead of two. Around that: the Errors tab now shows real **stack traces**, background jobs get a live **wait timer** you (and the agent) can see and adjust, and the sandbox gains a **universal write-escalation** safety net so unlisted toolchains stop failing on first run.

### Added

- **Per-job live wake timer.** `background_jobs` gains `wake_in` (set a countdown to re-check a job) and
  `adjust_timer` (change it); `list` shows a live `wake_in_s` remaining per timed job. One timer per job
  — setting again replaces it, and a job's timer is auto-cancelled when it finishes, so timers never pile
  up or orphan. `scheduled-wakeups.ts`, `background-commands.ts`, `background-jobs.ts`.
- **Runtime errors with stack traces in the Errors tab.** An injected page hook captures uncaught
  exceptions and unhandled promise rejections WITH their stack (relayed via a `[[ATLARIX_ERR]]` console
  sentinel — browser tabs have no preload), on top of console errors, load failures, and failed 4xx/5xx
  requests. The agent reads the same buffer via `browser_inspect(mode:"console")`. `error-hook.ts`,
  `browser_view_manager.ts`, `useBrowserErrorListener.ts`.
- **Clickable URLs open in a Browser tab.** http(s) links in chat and the terminal — and bare
  `localhost:PORT` URLs, now highlighted/linkified — open in an in-app Browser tab (⌘/Ctrl-click → system
  browser); each click stacks a new tab. `open-in-browser-tab.ts`, `localhost-url.ts`,
  `AtlarixMarkdownParser.tsx`, `XtermView.tsx`.
- **`allow_stalled` background-job opt-out.** Mark a quiet-by-design job (a dev server / watcher) so the
  harness stops pinging you about it going silent — it keeps running and still delivers its exit result.
  `background-commands.ts`, `background-jobs.ts`.
- **Keyboard shortcuts** for browser tabs, the model picker, and panel-tab navigation (Cmd+T/W/J/I/O);
  Cmd+J toggles the right panel.
- **Real-time device-spec injection** (CPU cores + RAM) so the agent sizes parallel work to the machine.
- **Escalation-on-denial for unlisted toolchains.** When a sandboxed command is denied a write to a
  path outside the writable set, an approval card offers to grant that exact path (persisted per
  workspace) and the command **re-runs, still sandboxed** — no enumerated cache list can be complete, so
  this is the universal safety net (the model Codex/Claude Code/Cursor all converge on). The denied path
  is parsed from the command's stderr (macOS does not log custom `sandbox-exec` denials to the unified
  log — verified; Linux gets an authoritative ptrace report). Reuses `workspaceFilePermissions` under a
  `sandbox_path` scope (no migration). `wrap-command.ts`, `interceptor.ts`, `InlinePermissionApprovals.tsx`.
- **Linux authoritative denied-path supervisor** (feature-gated ptrace/seccomp) as the follow-up to
  stderr-parse denial detection.

### Changed

- **Preview tab removed — unified on the in-app Browser.** `browser_navigate/inspect/interact` and
  `preview_test` drive a Browser tab; the old `target:"preview"` surface and its dev-URL auto-detect are
  gone; error capture migrated onto browser tabs; the in-app tools catalog and all prompts/docs updated.
  `browser.ts`, `browser_view_manager.ts`, `RightPanel.tsx`, `useRightPanelContext.ts`, `tools.tsx`,
  `mode-prompt-bundle.ts`.
- **Supabase idle background-ping reduction** — realtime heartbeat slowed, paused on window blur,
  `TOKEN_REFRESHED` short-circuited, and user-read TTL widened, so an idle app stops chattering.
- **CI fails loud when a native sandbox helper doesn't compile** instead of silently shipping the OS
  unsandboxed (override with the `ALLOW_UNSANDBOXED_RELEASE` repo variable). `release.yml`.

### Fixed

- **`browser_inspect(mode:"screenshot")` returned an empty image** when the panel/tab wasn't visibly
  open — it now routes through `capturePaintable` (off-screen attach → paint → capture). `browser.ts`.
- **localhost is allowed in the browser surface** (`allowLoopback`) so the agent can open the user's own
  dev server; LAN / link-local / cloud-metadata stay blocked.
- **`yarn install` (and any first-run toolchain) no longer fails `EPERM: mkdir '~/.yarn'`.** The
  sandbox pruned any writable cache dir that didn't exist yet, so the tool's first `mkdir` was denied.
  Curated caches are now granted even when missing — macOS emits a prospective Seatbelt `(subpath …)`,
  Linux/Windows create the dir first (Landlock/AppContainer need a real path). `wrap-command.ts`.
- **Code blocks no longer spill out of their box** and the double language label is gone (line-level
  CommonMark fence tracking in the frozen-tail splitter).

## [14.14.0] (2026-07-20) — Core web search, outside-workspace tools, resilience

`npm run check` 0/0, vitest green.

### Added

- **Atlarix Core web search.** Core models now search the web, model-invoked via OpenRouter's agentic
  `openrouter:web_search` server tool (pay-per-use, not an always-on plugin) — metered through the Core
  credit wallet at the standard markup, no separate setup. Per-tier opt-out via a `webSearch` map in the
  hosted `core-models.json` (a tier set `false` keeps the client SearxNG tool). `native_web_search.ts`,
  `core-model-override(-store).ts`.
- **Outside-workspace tool access.** The workspace is now a default _scope_, not a wall: `read_file` /
  `grep` / `glob` accept absolute paths anywhere (reads auto-allowed), and `edit_file` accepts an absolute
  path outside the workspace but still routes through the diff + approval gate — no more `sed`/`python`
  shell-edit workarounds for cross-repo/dependency work. New `resolveToolTargetPath`
  (`safeWorkspaceRelativePath.ts`); relative paths stay confined.

### Fixed

- **Permission writes no longer wedge a turn.** A disk-full / `SQLITE_CANTOPEN` while persisting an
  "always allow" rule is now best-effort (the command still runs) with a one-time disk-full notice, instead
  of throwing out of IPC and parking the turn (`permissions/persist-safe.ts`, sibling handlers).
- **Dead Core metering error removed.** The old monthly-token-limit system (`get_compass_usage_state` —
  already dropped in Supabase) logged an error on every Core turn; the redundant client preflight/
  enforcement is deleted (the PAYG wallet is the sole enforcement). Live token helpers relocated to
  `lib/usage/ai-usage.ts`.

### Changed

- **Sandbox writable roster is env-driven** — resolves each toolchain's store from its standard env var
  (`PNPM_HOME`, `CARGO_HOME`, `GOPATH`, `XDG_*`, …) then known defaults, so a custom pnpm/cargo/etc. store
  outside the workspace isn't denied (fixes pnpm installs stalling). `wrap-command.ts`.
- **Conservative dependency de-deprecation** (build-time only) — removed the vestigial eslint stack, bumped
  `@electron-forge/*` → 7.11.2 and direct `glob` → 13; deprecation warnings 18 → 15.
- **Leaner agent prompting** — trimmed ~475 words of redundant/over-steering guidance (`run_command`
  description 476→~140 words, de-duplicated "verify before you stop", compressed the browser note) without
  touching the mode gating or the security contract.

### Note

- Web-search **sources are captured but the citation strip does not yet render** — tracked for a fast
  follow-up (14.14.1). Search results themselves work.

## [14.13.3] (2026-07-18) — Auto-update fixed on all platforms

`npm run check` 0/0, vitest green.

### Fixed

- **Auto-update no longer stuck on "Downloading…".** electron-forge never generates `app-update.yml`,
  which electron-updater reads at download time, so the download threw an unhandled `ENOENT` and the
  banner stuck forever. Ship a static `build/app-update.yml` via `extraResource` (lands in
  `Contents/Resources/`, signed with the bundle) and harden the flow: drive `downloadUpdate()` ourselves
  with a `.catch` so failures surface as an error state, `disableDifferentialDownload` (no `.blockmap`
  published), unified deferred-install path (`src/main.ts`, `forge.config.ts`). Fixes macOS
  (in /Applications) + Linux AppImage.
- **Windows auto-update rebuilt on the Squirrel-native path.** Windows ships Squirrel.Windows installers
  (`MakerSquirrel`), which electron-updater can't drive — it only supports NSIS. Windows now updates via
  Electron's built-in `autoUpdater` + `update-electron-app` / update.electronjs.org, mapped onto the same
  update banner/status IPC (`src/main.ts`).

### Added

- Pure `chooseUpdaterKind()` platform selector (`src/main/update-helpers.ts`) + unit tests — Windows →
  squirrel, mac/Linux AppImage → electron-updater, else → notify-only bridge.
- CI publishes the Squirrel `RELEASES` index + `*-full.nupkg` for Windows (needed by
  update.electronjs.org); dropped the unused/broken NSIS `latest.yml` step (`.github/workflows/release.yml`).

### Note

- **One-time manual update:** installs on ≤14.13.2 lack `app-update.yml` and can't auto-update to this
  fix — they need a single manual install of v14.13.3, after which auto-update self-heals.

## [14.13.2] (2026-07-18) — Core provider UI, faster model list, auto-update fix

`npm run check` 0/0, vitest green.

### Added

- Atlarix Core provider page now shows the **real, live model names** (Kimi K2.7 Code, Qwen3.7 Plus,
  DeepSeek V4 Pro, MiniMax M3) instead of `Core N` placeholders. `useAtlarixCoreCatalog` derives from
  `useLanguageModelsByProviders` — the same working IPC the model picker uses — via new
  `coreTierPresentationFromModel()` (`src/lib/atlarix-core-catalog.ts`). The `compass:get-tier-catalog`
  IPC resolved the ids through a different `compass_constants` module instance (alias vs relative
  import) than the runtime override store is written to, so it returned placeholders.
- Ollama / LM Studio providers use a single-select model list (`LocalProviderModelSelector.tsx`,
  replacing the dead 3-slot `LocalProviderFavoritesSelector`).

### Fixed

- Atlarix Core badge now reads **"Setup Complete"** — it needs no API key
  (`src/components/settings/ProviderSettingsPage.tsx`).
- Auto-update could get stuck on "Downloading": the deferred-update cold-start path ran a second
  `checkForUpdates()` before the feed URL was set and registered a duplicate `update-downloaded`
  handler, racing the real download. Unified into one flow; added
  `autoUpdater.disableDifferentialDownload = true` (no `.blockmap` files are published) (`src/main.ts`).

### Changed

- Retired the Fast/Balanced/Thinking tier vocabulary from the provider UI: "Needs Setup" → **"Add
  key"**, tier-free "Add custom provider" caption + dialog copy (`ProviderSettings.tsx`,
  `CreateCustomProviderDialog.tsx`).

### Performance

- `staleTime: 5 min` on `useLanguageModelsByProviders` + `useLanguageModelsForProvider` — the
  167-provider models.dev catalog was rebuilding on every mount/window-focus. Provider CRUD, the
  core-models refresh, and the manual "Refresh model list" button still invalidate these keys.

## [14.13.1] (2026-07-18) — Cleaner markdown, hidden untrusted-data envelopes, clearer wallet

`npm run check` 0/0, vitest green.

### Added

- **Markdown structure rule.** The `<output_style>` block now tells every model never to place
  multi-line code, a fenced block, or a line-breaking template literal inside a table cell or
  inline backticks (GitHub-flavored markdown cannot render either — the row/span breaks apart);
  keep table cells single-line and put multi-line code in a fenced block outside the table
  (`src/prompts/system_prompt.ts`). Fixes tables rendering with phantom rows and inline code
  leaking stray `{`/`}` text.
- **`stripUntrustedDataEnvelope()`** display helper (`src/lib/streaming/untrusted-data.ts`),
  reusing the existing reversible `unescapeAttachmentTagBody` inverse.

### Fixed

- **`<untrusted-data>` envelope no longer leaks into the UI.** The injection-defense envelope
  that wraps external tool output (command output, MCP, web/browser, automation) so the _model_
  treats it as data was being shown verbatim to users in tool cards. It is now stripped on the
  display path across command, read, MCP, web-search, browser, and preview/summary views
  (`src/lib/chat/tool-expand-view.ts`, `src/lib/chat/stream-tool-display.ts`,
  `src/lib/chat/format-tool-result.ts`). The model-facing and persisted strings keep the wrapper,
  so the defense survives reload/replay/re-dispatch; comment corrected in
  `src/ipc/handlers/permissions/interceptor.ts`.
- **Negative wallet balance is explained.** When a refund clawback leaves the Atlarix Core credit
  balance negative, the wallet card renders it in a distinct color with a note that a prior refund
  was applied and to top up before using Core (`src/components/settings/AtlarixCoreUsageCard.tsx`).

### Tests

- Round-trip + passthrough coverage for `stripUntrustedDataEnvelope`
  (`src/__tests__/untrusted-data.test.ts`) and a command-card envelope-strip assertion
  (`src/__tests__/tool-expand-view.test.ts`).

## [14.13.0] (2026-07-17) — Co-author (not author) commits, working toggle, markdown replies

`npm run check` 0/0, vitest green.

### Added

- **Markdown output guidance.** The `<output_style>` block now tells every model its
  user-visible replies render as GitHub-flavored markdown — use headings, lists, fenced code
  with a language tag, and tables where they aid clarity, without over-formatting short
  answers (`src/prompts/system_prompt.ts`).

### Fixed

- **Atlarix is credited as co-author, not author.** Commits are authored by the user's own
  git config again; Atlarix is credited only via the `Co-authored-by:` trailer. Both the
  terminal `git commit` path (`src/ipc/handlers/permissions/interceptor.ts`) and the
  programmatic auto-commit path (`src/ipc/utils/git_utils.ts` `gitCommit`) now attribute the
  agent identity **only** as a fallback when the machine has no configured git identity — via
  a new `hasConfiguredGitIdentity()` probe — so a bare machine's commit still succeeds instead
  of failing.
- **"Add Atlarix as co-author" toggle now works on the terminal path.** The setting
  (`includeAtlarixCoAuthor`) previously only gated the trailer inside the programmatic helper;
  the terminal/prompt path added it unconditionally. The commit-authoring note is now gated on
  the setting and no longer instructs `--author` (`src/lib/tools/mode-prompt-bundle.ts`,
  threaded from `src/prompts/system_prompt.ts`).

### Changed

- **Security scope trimmed.** Dropped four deferred "protect the user from their own agent"
  items from the roadmap (egress gating, sandbox read-confinement, spawned-command env-var
  allowlist, automation allowlist-flip) — matching opencode / Claude Code. Owner-protection
  (payments, keychain, IPC gating) and the prompt-level untrusted-data defense are unchanged.

### Tests

- Real-git worktree suites (`subagent-cancel`, `subagent-worktree`) given the repo's 30s I/O
  budget on their hooks/tests to end chronic load-flakiness (default 5s test / 10s hook was
  too tight for real `git init`/commit/`worktree add` subprocesses under parallel load).

## [14.12.0] (2026-07-16) — Harness fixes, real model pricing, edit_file overhaul, security hardening

`npm run check` 0/0, vitest green.

### Added

- **Model-picker real pricing.** `$/M` from the models.dev catalog is merged into every provider's
  natively-fetched models, and OpenRouter's own per-token pricing is parsed directly — the picker's
  `PriceBadge` shows real cost instead of "Free". Locals stay "Free", Core "Paid".
- **`edit_file` — multi-edit + elision-merge (weak-model robustness).** `operation:"replace"` now accepts
  an `edits` array applied atomically in one call (nothing written if any hunk fails). New
  `operation:"merge"` (Cursor-style): give the file's new shape with `// ... existing code ...` markers for
  unchanged spans — stitched in deterministically (no apply-model), refusing rather than corrupting when a
  marker can't be anchored.
- **Live token counter** now updates from an always-mounted composer hook (works with the usage popover
  closed) and holds occupancy across turns instead of dropping to the client estimate.
- **`wake_on` nudge** — the run_command tool steers the model to attach a completion pattern
  (`BUILD SUCCESSFUL|BUILD FAILED`, …) when backgrounding builds/tests/installs, for precise "is it done?"
  detection instead of the silence heuristic.

### Changed

- **Wait-timer merge.** A background job's stall watchdog is snoozed while the model has an active
  `schedule_wakeup`; carriage-return progress redraws no longer re-arm the advisory; the idle threshold is
  180s→300s and the advisory is reframed toward patience (quiet builds are normal — don't cancel). Fixes the
  "3-min pinger fires despite a longer wait" and the auto-wake retry loop.
- **File reads align with opencode / Claude Code.** In-workspace files (incl. a project's own `.env` / keys)
  read freely; the read-side gate is the workspace boundary only (path-escape + a new symlink realpath
  check). Reading a credential file via a shell command still hits the run_command danger-gate, which asks.
- **`ask`→"Explore" skill matching** is case/label-tolerant (reads `modes` and `compatibleModes`).

### Fixed

- **Paste** — a long paste no longer freezes the app or lands as inline text: the clipboard is read once,
  `preventDefault` is synchronous, and large pastes become a chip instantly.
- **Images** — a provider that rejects image input (text-only chat API, e.g. DeepSeek) now returns a clear
  "switch to a vision model" message instead of a raw JSON deserialize error; capable models still send
  images with no allowlist.
- **PriceBadge clipping** in the model picker (Radix scroll-area content sizing).
- Removed the dead LLM error-fallback in the Errors tab (deterministic SARIF + matcher path kept).

### Security

- **Plaintext-keychain fallback hardened** — the settings file is `chmod 600` on POSIX, a renderer banner
  warns when no OS keystore is available, and secrets are re-encrypted once a keystore returns.
- **Privileged IPC gated** — `terminal:run` and execute/reject-all-permissions now go through the
  origin-gating handler with zod payload validation; `mcp:create-server` gets a runtime shape check.

## [14.11.0] (2026-07-14) — Pricing reframe: Free + Pro + PAYG credits

`npm run check` 0/0, vitest **1572** green. Multi-repo refactor (app + proxy + edge functions +
Supabase migrations + launchpad). Backend migrations applied to prod; proxy + edge functions deployed.

### Changed

- **Pricing reframe — no tier bundles AI.** Atlarix is a harness, not an AI provider: **Atlarix Core is
  pay-as-you-go prepaid credit on every tier**. The **Team/`workforce` tier is removed** (its one-click
  OAuth connectors fold into Pro); "Studio"→"Pro", "Solo"→"Free". Free = full harness on BYOK/local +
  bounded scale (1 workspace, 1 MCP/ws, 2 automations); Pro ($19/mo) = unlimited workspaces, 10 MCP/ws,
  10 automations, marketplace + connectors.
- **Metering → credit wallet.** The monthly token _allowance_ (`compass_tokens`) is replaced by a dollar
  _balance_ (`credit_wallet` + append-only `credit_transactions`, idempotent SECURITY DEFINER RPCs). The
  proxy meters the **real OpenRouter cost + 40% markup**, and **gates each call on a per-call cost
  reserve** (est input + max output × price × markup) — a user always affords the call they start; it
  never aborts mid-stream. Two exhaustion cases split cleanly: user out of credit → **402
  `insufficient_credit`** (top-up message); managed key fails → **503 `core_unavailable`** + neutral
  "overloaded" message + owner Discord alert (`CORE_ALERT_WEBHOOK_URL`).

### Added

- **PAYG wallet UI** — credit balance + **additive top-up tally** ($10/$20/$50/custom, running total +
  reset + confirm, $10 min) via a single LemonSqueezy "Atlarix Core Credit" product with per-checkout
  `custom_price`; `order_created`/`order_refunded` webhook credits/claws back. Balance shown in the token
  bar and account menu.
- **Automations gate** (net-new): Free 2 / Pro 10 per workspace. **One-time $1 signup trial credit**
  (`claim_signup_credit`, fired on sign-in). **Low-balance nudge** (one-time toast under $1).
- **vNEXT (commit `8d1e990`).** Voice-to-text (on-device Whisper + BYOK cloud), live provider-usage token
  counters (main + per-sub-agent), unified content-hash attachment dedup, image-gate removed (user images
  → any model), DB-closing guard, optimistic stop + mid-stream edit.

### Fixed

- OAuth **avatar CSP** (GitHub/Google profile pictures were blocked → placeholder).
- Model picker labels Atlarix Core as **"Paid"** (was "Free").
- Wallet RPC idempotency index (`ON CONFLICT (kind, ref)` needs a non-partial unique index — the partial
  index silently failed every wallet write, incl. debits).
- Two chat nits: empty state reads "What are we building?"; the duplicate New-chat header removed.

### Removed

- Team/`workforce` tier surface (team-service, team handlers, invite banner, upgrade-choice dialog,
  workforce checkout/IPC). Dead **DB-Studio-legacy** plumbing. Launchpad Team pages + stale allowance/
  Blueprint docs claims.

### Migrations (Supabase `oubgrpkqyyjwytspycpd`, applied to prod)

- `20260714120000_credit_wallet` (wallet + RPCs) · `20260714140000_fix_credit_conflict_index` (index fix)
  · `20260714130000_pricing_reframe_teardown` (drop teams + compass allowance, tiers → `free|pro`, rewrite
  the users guard trigger).

## [14.10.0] (2026-07-12) — Command permissions rebuilt + accuracy skills + streaming/UI overhaul

Net **−362 lines**; `npm run check` 0/0, vitest 1566 green, knip clean, packaged self-test 4/4.

### Changed

- **Command permissions rebuilt on the Codex sandbox + Claude Code ask model.** Deleted the
  hardcoded read/mutate/git command taxonomies (`command-mutation.ts`, `command-default-allow.ts`,
  `git-init-command-guard.ts`) that false-blocked valid commands (`git fetch`, `docker build`) in
  read-only modes. Enforcement is now the OS sandbox: Explore/Plan/Review get a **read-only**
  profile (workspace source not writable), Build/Debug keep workspace-write (`work-mode.ts`,
  `sandbox/wrap-command.ts`, native `atlarix-sandbox`/`atlarix-sandbox-linux` gained `--read-only`).
  Commands **auto-run** in the sandbox; only the danger gate (`dangerous-commands.ts`) and user
  `.atlarix/permissions.json` rules prompt. The CPU-throttle experiment was fully stripped.
- **Accuracy prompt-skills** (`lib/tools/mode-prompt-bundle.ts`) — Build/Debug now require a test
  to be **red against the un-fixed code before it's trusted green** (kills tests that pass without
  exercising the code), to **assert on the real code path not a mock of the unit under test**, to
  **switch verification approach after ~2–3 repeats** instead of flailing, and to **reuse existing
  utils/deps before writing new code**.
- **Dead-code removal** — trimmed the orphaned task-ledger/plan-step helpers and deleted
  `completion-detector.ts`.

### Fixed

- **UI heat + streaming render overhaul** — react-virtuoso message virtualization (default-on,
  kill-switch), adaptive flush cadence, tail-bounded markdown re-parse, atom-fanout narrowing,
  one-time stale-index cleanup (`main/startup/cleanup-legacy-index-dirs.ts`), and a grep/glob
  search label. Keeps the main process calm and cool on large repos and during long streams.
- **Reconnect no longer shows a fake "user said continue" turn.** Resuming an interrupted turn
  (`SimpleInlineChat` continue) now sends an out-of-band `<system-reminder>` continuation
  (`buildInterruptedContinuePrompt` in `lib/chat/stream-transport.ts`, threaded via a new
  `continueInterrupted` flag) instead of a persisted user message.
- **"Jump to latest" lands at the live generating edge** — `VirtualizedMessageList` scrolls with
  `align:"end"` so a tall streaming message pins to the bottom, not its top (mid-screen).

## [14.9.1] (2026-07-10) — Bundle ripgrep (self-contained grep/glob)

### Fixed

- **`grep`/`glob` no longer depend on the user having `rg` on their PATH.** They
  now use a bundled ripgrep binary via `@vscode/ripgrep` (the same package VS
  Code / Claude Code ship), resolved through `lib/tools/resolve-ripgrep.ts` with
  a PATH fallback. The binary ships unpacked from the asar
  (`@vscode/ripgrep-<platform>-<arch>/bin/rg`, forge `asar.unpack`); the packaged
  `--self-test` confirms it resolves the bundled binary, not PATH. Also installs
  ripgrep in the CI quality/linux jobs (belt-and-suspenders) and removes a stale
  `chokidar` entry from the Vite main externals so it isn't re-installed into the
  package.

## [14.9.0] (2026-07-10) — Lightweight retrieval teardown + opencode-parity providers

The harness gets dramatically lighter and cooler on large repos, and gains full
multi-provider parity. Net **−5,246 lines**; vitest 1621 green, oxlint 0, ts/knip clean,
packaged self-test 4/4.

### Fixed

- **fd-leak + high CPU/heat on large repos (root cause).** The `search-index-watcher`
  (chokidar 4) on macOS used `fs.watch`/kqueue = **one open fd per watched file** → ~12,365
  fds on a Jenkins-scale repo → `spawn EBADF` on every child process, plus sustained heat
  from FTS5 rebuilds reading every file. The entire watcher + index apparatus is deleted;
  the main process now stays calm and fd count stays flat (~113) under real load.

### Changed

- **Retrieval collapsed to pure ripgrep** — same shape as Claude Code / opencode / codex.
  Deleted `search-index-watcher` (chokidar), FTS5/SQLite/BM25 (`fts5-index`, `fts5-core`,
  `bm25_semantic_index`, `retrieval-common`, `package-boundaries`), the grep reranker
  (`grep-blueprint-reranker`), ctags/symbols (`lib/index/*`), and the dead
  `lib/analysis/*` workspace-analyzer→diagram→context chain (ran a full-repo ctags scan
  that nothing consumed). `lib/tools/grep.ts` + `lib/tools/glob.ts` now both run on ripgrep;
  `--no-require-git` + optional `--ignore-file` (`lib/tools/ripgrep-ignore.ts`) honor
  `.gitignore`/`.ignore`/`.atlarixignore` even outside a git tree. Removed the
  `atlarix-ignore` module, the bundled ctags binary, and the `fetch-ctags` machinery
  (postinstall + CI steps + assets).
- **Dependency diet** — removed 4 extraneous deps (`dompurify`, `marked`,
  `@tanstack/react-virtual`, `wink-bm25-text-search`) + `chokidar`. Removed 11 retrieval
  test files.

### Added

- **opencode-parity multi-provider.** `getLanguageModelProviders`
  (`ipc/shared/language_model_helpers.ts`) now merges a third source — the full models.dev
  catalog (`getModelsDevProviderCatalog`, `lib/models_dev.ts`): every provider carrying a
  base URL (~124 net-new) is connectable via the shared OpenAI-compatible `default:` path in
  `ipc/utils/get_model_client.ts`; hardcoded/custom providers still win by id. Models +
  context limits stay live (provider-native `/models` first, models.dev fallback) with an
  hourly auto-refresh and last-good-cache fallback.
- **Per-sub-agent token usage.** Each sub-agent's total tokens (`lib/agents/run-subagent.ts`)
  now show as a badge on its run card (`components/chat/subagent/SubAgentRunCard.tsx`),
  alongside the existing session total + "Sub-agents (last turn)" readout in `TokenBar`.
- **Terminal background-tab auto-close** (`components/panels/TerminalPanel.tsx`) — a
  background command's dedicated tab auto-closes ~6s after it exits successfully; failed
  commands and long-running servers stay, and foreground commands keep sharing the one
  persistent "Agent" tab.

## [14.8.16] (2026-07-10) — Hotfix: wire the Core proxy URL into release builds

v14.8.15 stripped `COMPASS_OPENROUTER_API_KEY` from the client and moved Core behind
`atlarix-proxy`, but the release workflow never passed the new `ATLARIX_CORE_PROXY_URL`
into the build env — so the shipped 14.8.15 binary embedded no proxy endpoint and Core
failed with "Atlarix Core is not configured for this build." This wires
`ATLARIX_CORE_PROXY_URL` into `release.yml`'s env block (covers mac/linux/windows) and
drops the now-dead `COMPASS_OPENROUTER_API_KEY` env. No app-code change; Core works again.

## [14.8.15] (2026-07-10) — Atlarix Core moves server-side: zero client secrets, hardened entitlement

tsc + oxlint clean; vitest **1681** green. A security-architecture release that **closes the
embedded-secrets item (C-1) left open in 14.8.14** — the client now ships with **no server
secrets at all**. From a 20-agent audit of the Supabase backend + Core-key handling
(`docs/SUPABASE_SECURITY_AUDIT.md`, kept local). **Known-open (tracked in `docs/TODO.md`):**
residual high CPU/heat under a hot suspect (terminal-output streaming).

### Atlarix Core → hosted proxy (SB-02 / SB-06)

- The managed OpenRouter key **no longer ships in the app**. Core requests now route through a
  new server-side proxy (`atlarix-proxy`, Hono on Railway): it verifies the caller's Supabase
  JWT, enforces the monthly Compass quota, forwards on the master key (server-only), and meters
  usage server-side (the client can no longer skip metering).
- `get_model_client.ts` `compass` case authenticates with the user's `session.access_token` and
  a public `ATLARIX_CORE_PROXY_URL` (new `core_proxy.ts`); a local dev key is the only fallback
  and is never present in a release. Client-side usage recording is now dev-only to avoid
  double-counting. The proxy's Core-model allowlist syncs from the hosted `core-models.json`, so
  switching Core models stays a one-file edit — no redeploy.

### No server secrets in the client bundle (A1 / A2 / A3)

- `vite.main.config.mts` `define` **stripped of** `COMPASS_OPENROUTER_API_KEY`,
  `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `RESEND_API_KEY`.
- Checkout, subscription-cancel, and transactional email moved to Supabase edge functions
  (`create-checkout`, `cancel-subscription`, `send-email`) authenticated by the user's JWT;
  `lemonsqueezy.ts`, `auth_handlers.ts` cancel, and `email/resend.ts` now call those functions.

### Entitlement + billing hardening (SB-01 / SB-03 / SB-04 / SB-07 / SB-10)

- Migration `20260710120000`: authoritative `teams.tier`, guard triggers that block client team
  creation, membership `team_id` redirects, and self-inserted active memberships, plus a rewritten
  `guard_users_sensitive_columns` that validates `effective_tier` **independently** against the
  team's real tier — closing $0 self-escalation to Workforce.
- `handle-lemon-webhook` keys account mutations off the verified `custom_data.supabase_user_id`
  (never the payload email) and uses a constant-time signature compare.

## [14.8.14] (2026-07-09) — Security fixes, reference-grade command permissions, cross-platform performance overhaul

tsc + oxlint clean; vitest **1682** green (+ knip no new orphans). A large hardening + performance
release. **Known-open (tracked in `docs/TODO.md`):** residual high CPU/heat under a hot suspect
(terminal-output streaming), and the embedded-secrets rotation (C-1) still pending a backend.

### Security (from a full 5-agent audit)

- **grep tool no longer shell-injectable** — `src/lib/tools/grep.ts` builds an `execFile` argv (no shell).
- **Egress + SSRF** — `read_url` and `browser_navigate` both route through `assertUrlAllowed`, which now
  also blocks URLs carrying a secret shape (`src/lib/security/url-policy.ts`); web-search fetches use `safeFetch`.
- **IPC trust boundary** — main-frame `will-navigate`/`will-redirect` lockdown (`src/main.ts`) + a
  production-only sender-frame guard (`src/ipc/handlers/safe_handle.ts`).
- **Danger taxonomy** — generic interpreter-eval + reader-agnostic credential-path detection
  (`src/lib/dangerous-commands.ts`); automations deny on `systemScope`; single-`&` is now a command separator.
- **Symlink write-escape guard** (`interceptor.ts` realpath check), browser untrusted-content envelope hardened,
  Sentry `beforeSend` secret redaction, fail-closed workspace limits, OAuth loopback path guard, `chromiumSandbox: true`,
  a packaged-only CSP, and glob `..` rejection.

### Command permissions — reference-grade per-segment model (opencode / Claude Code)

- The gate now evaluates **per segment**: a command auto-runs only if EVERY segment is allowed (a user rule OR
  a built-in default read); **deny wins**; dangerous segments still key on `danger:<id>`; system-scope never
  silently auto-allows. A user "always allow npm" now composes inside `npm test && ls`.
  (`src/lib/command-default-allow.ts`, `src/ipc/handlers/command_permission_handlers.ts`.)
- Built-in read-only defaults (`ls/grep/find/cat/…` + pipelines of them) are visible + deny-overridable in
  Settings → Terminal permissions (`WorkspaceTerminalPermissions.tsx`).

### UX

- **Paste from any source** — a large paste now becomes an attachment chip even from rich-text apps (Notes/TextEdit):
  `text/plain` falls back to stripped `text/html` (`src/lib/chat/text-paste-attachment.ts`, `useAttachments.ts`).
- **One completion sound** — task-done no longer double-plays the in-app chime alongside the OS notification (`useStreamChat.ts`).
- **Chat render-cap** — only the last 120 messages mount, with a "Show earlier messages" button, so long sessions
  stay light (`SimpleInlineChat.tsx`). Streaming scroll-follow hardened against the "scroll fight" (`useStickToBottom.ts`).

### Performance (cross-platform)

- **File watcher → `chokidar`** (pure-JS; no native compile) with the composed `.gitignore`/`.atlarixignore` ignorer
  applied as chokidar's `ignored` so node_modules/.git are PRUNED at traversal and never watched — replaces the
  recursive `fs.watch` firehose (which flooded the main thread and threw on Linux). (`src/lib/search/search-index-watcher.ts`;
  graceful-degrades if chokidar is absent; torn down on quit.)
- **First-grep unblock** — sampled path validation instead of `existsSync` over every file (`ctags-index.ts`);
  FTS5 rebuild reads bounded to 64-concurrent (`fts5-index.ts`).
- **Memory** — ctags symbol cache LRU-capped (3 workspaces); FTS5 DB handles LRU-capped (4, safe close).

### Cleanup

- Removed the dead legacy `/chat` page + its orphan chain (~12 files; `ChatInterface`, `InputBar`, `ChatHandler`,
  legacy providers).

## [14.8.13] (2026-07-07) — Universal sandbox, system-scope gate, security hardening, notifications

tsc + oxlint clean; vitest **1635** (node 1504 / renderer 58 / agent-evals 73). The first release
since **v14.8.11**, so this is a large cumulative update — it rolls up everything below plus the
previously-unreleased platform bundle (Automations, native-git reads, Code-tab removal, universal
language, the `chat_stream_handlers` 7984→2364 decomposition). Security detail:
`docs/SECURITY_REVIEW_v14.8.12.md`.

### Added — sandbox, system-scope gate, notifications

- **Self-contained write-confining sandbox on every OS.** `run_command` writes are confined to the
  workspace + caches (reads + network stay open) via the OS's own kernel sandbox — macOS Seatbelt
  (built-in), a bundled Windows AppContainer helper, and a bundled Linux **Landlock** helper (falls
  back to `bwrap`, then unsandboxed). Ships unsigned for now; CI signs the Windows helper only when a
  cert is configured, and never blocks a release if a helper fails to build.
- **System-scope approval gate.** A command that changes things OUTSIDE the project — an on-device
  install (`brew`/`apt`/`rustup`/`npm -g`/`cargo install`/…), `sudo`, or a write outside the workspace —
  shows a distinct **"System change"** approval and is never silently auto-allowed. Approving it runs
  that one command unsandboxed so the install works; unattended Automations never get the prompt and
  stay sandboxed.
- **"Finished responding" desktop notification.** The same OS notification used when Atlarix needs you
  now also fires when a turn finishes (any mode, incl. a text-only Explore answer) — when the app is in
  the background. On/off + volume in Settings → General.

### Fixed (harness contracts)

- **Shift+Tab mode-cycle works while busy.** The binding was dropped whenever focus was
  in the composer or a stream was in flight (it sat below the input-focus guard); it's
  now global + always-live, like Cmd/Ctrl+B.
- **Streaming scroll no longer fights you.** An intentional upward scroll (wheel / touch /
  PageUp) now synchronously disengages auto-follow, so the ResizeObserver re-pin can't
  yank you back to the bottom mid-stream.
- **Attached images reach capable models.** The models.dev vision registry is warmed
  before the attach gate, so a cold cache no longer silently drops a DeepSeek/Qwen
  attachment (screenshots worked only because their gate ran later, warm).
- **MCP auth waits are truly indefinite.** The 5-min agent wait and 60-s OAuth flow
  timeout are removed — every human-in-the-loop MCP auth wait blocks until you resolve it
  (or Stop), matching command/file approvals.
- **Read-only mode blocks read clearly.** A mutating command blocked after a mid-session
  mode switch now returns a terminal "this is a MODE restriction, not permissions — don't
  retry" message instead of a soft failure the model looped on.

### Security (audit-driven; full report in `docs/SECURITY_REVIEW_v14.8.12.md`)

- **Compound-command danger gate.** `echo ok && rm -rf ~` (and `; | && ` chains, `$()`)
  are evaluated per segment — a risky command can no longer hide behind a benign prefix.
- **Exfiltration taxonomy.** Inline-eval interpreters (`node -e`, `python -c`), `gh` write
  verbs, credential-file reads, and remote-shell/netcat tools (`ssh`/`scp`/`nc`) are now
  dangerous — denied in unattended Automations, prompted interactively.
- **Deep-link hardening.** `atlarix://auth/callback` is rejected unless a sign-in flow is
  in progress (was one-click account-takeover); `atlarix://pro-return` requires an explicit
  confirmation before writing an API key / enabling Pro.
- **MCP consent + trust.** Attended MCP tool calls now prompt for per-tool consent (was
  unwired); tool descriptions are framed as untrusted data; the server-supplied OAuth URL
  is validated to http(s) before opening.
- **`.atlarix` authority files.** Writes to `.atlarix/atlarix.md` and
  `.atlarix/permissions.json` require normal approval (were blanket auto-approved).

### Added

- **Notification sound + OS notification when Atlarix needs you.** A chime (and an OS
  notification when the window is unfocused, respecting Do-Not-Disturb) fires when a turn
  waits on you for approval or a question. On/off + volume in Settings → General.

### Changed

- **Prompt refinement.** Distilled model-agnostic guidance into `AGENTS.md`
  (ground-claims-in-tool-results, finish-the-turn, report-don't-act, lead-with-outcome);
  reframed Debug's "state your hypothesis in your reply" to an action-first form (avoids a
  `reasoning_extraction` refusal on Claude-5-family models); `git checkout`/`switch` branch
  navigation is allowed in read-only modes (discard forms stay blocked).

### Platform bundle (rolled into this release) — native-git reads, Code-tab removal, universal language, Automations

#### Added

- **Automations** — Codex-app-style local recurring triggers with a triage feed, in the tab slot
  freed by the Code tab. Notify-only by default (a fired trigger posts to the feed with zero model
  involvement; "Send to chat" hands the event to your active session). Triggers: **schedule** (presets
  or cron), **GitHub polls** (new PR / review requested / CI failed — deterministic, cursor-seeded,
  zero LLM cost), **MCP polls** (fire on result-hash change). Opt-in agent runs execute through the
  `chat:stream` engine's headless spine: **read-only** or **worktree-write** (diff surfaces as a
  reviewable `git apply --3way` proposal). Dangerous ops always denied unattended; 10-min budget;
  concurrency 1. Results land in a triage feed (unread badges, nothing-to-report auto-archives,
  sonner/OS notifications); transcripts persist as background chat sessions; interrupted runs recover
  on boot. (Migration `0066_automations`.)

#### Fixed

- **Version history no longer crashes on large repos (production Sentry `null.slice`).** All local git
  ops shell out to system git (isomorphic-git buffered whole packfiles → hard-fails at 2 GiB);
  `enableNativeGit` deleted; isomorphic-git kept only as a lazy no-binary fallback for
  clone/push/set-remote. `list-versions` degrades to `[]` with one warning per workspace.
- **ast-grep no longer mis-parses unknown languages as TypeScript** — unregistered grammars are skipped.

#### Removed

- **ast-grep, blast-radius, and the dead blueprint-parse chain.** A consumer trace proved the working
  "Blueprint" is ctags + FTS5/BM25 only (grep reranking); ast-grep edges fed only the blast-radius line,
  silently broken in every packaged build. Deleted the ast-grep engine + worker + grammars (3 native
  deps), blast-radius, orphaned structural search, the whole dead parse chain, and 4 inert settings;
  the watcher slimmed to incremental ctags/FTS5 refresh. Grep reranking + enclosing-symbol annotation
  unchanged.
- **The Code tab, Monaco, and Cmd/Ctrl+P (QuickFileOpen).** Monaco (+5 workers, 812K grammars, a
  postinstall download) powered one component. Chat code blocks (shiki), agent diffs, write proposals,
  the Errors tab, and approve/reject are independent and unchanged; write-proposal cards render
  read-only with highlighting. `@file:`/`@dir:` mentions untouched.

#### Changed

- **`run_command` steers file-finding/content-search to `glob`/`grep`** (indexed, permission-free);
  `ls` still fine for listings.
- **Language support is universal.** ctags extension allowlist deleted (auto-detect ~150 languages +
  2 MB size gate); symbols carry their ctags `language`; a project with no marker file gets a real
  ctags-only blueprint; the workspace analyzer runs on the shared ctags index + one universal
  import-pattern pass — chat context + diagrams work for any language.

## [14.8.11] (2026-07-04) — Attachment fidelity, edit re-indentation, honest compaction, real context windows, ordered stream UI

Harness-fidelity release (every issue an observed live failure). tsc/oxlint/knip clean; vitest **1658**.

### Fixed

- **`edit_file` fuzzy matches re-anchor `new_content` to the file's REAL indentation** — a space-indented
  input into a tab file no longer splices verbatim (mixed indentation). Mapped lines adopt the matched
  region's indents, novel lines extrapolate by indent-unit delta, ambiguity falls back to verbatim.
- **Interrupted turns no longer erase attachment content** — paste-attachment ids are always the
  deterministic content-hash; send-time persist retries once; editing a message regenerates its
  model-facing content for both transport and DB.
- **`compress_context` tells the truth and actually compacts** — model calls force past the gate, the
  ratio uses the meter's scope, one exact counter feeds every number, the banner is success-gated.
- **Context windows come from real provider data** — per-model hardcode table deleted; resolution is
  user override → OpenRouter catalog → provider row → models.dev → logged fallback (native DeepSeek
  sees its real 1M); the Settings token-budget override wins everywhere incl. the compaction denominator.
- **Sub-agent cards read like the main chat** — reasoning segments rotate at every tool boundary
  (thought → tool → thought, in order).
- **Compaction/background cards render inline at their real position** via a pure timeline-weave.
- **Editing a sent message keeps its attachment chips** (stub tags stripped, rendered as read-only chips).

### Fixed (post-smoke)

- **Attachments survive edits + relaunches** — records carry the session UUID as the primary scope key;
  edit-resends rebuild the attachment directive.
- **Attachments are scoped to their conversation** — records tagged with their owning chat; the tools
  filter to an injected scope (no cross-session leaks).
- **Images on OpenAI-compatible vision providers** — the tool-media gate is API-format-driven while
  image input capability (models.dev) drives the user-message embed; a text-only-tool API gets an
  explicit "image is embedded / re-attach — do not guess" result. (`deepseek-v4-pro` is text→text per
  catalogs — its refusal is correct.)
- **Native multimodal models receive images** — models.dev input modalities feed `detectVisionCapability`;
  the non-vision placeholder forbids guessing from a filename.
- **Sub-agent popup unwraps to the final `<task_result>` markdown** (no raw envelope JSON).
- **Tab-strip titles follow session renames.**
- **Drag-and-drop attachments don't delay turn start** (PDF pre-extract moved off the send path).
- **S18: full-history tokenization ran ~3×/turn** — `exactTokenCountText` gained an LRU memo (O(1) for
  unchanged history).
- **Local providers (Ollama/LM Studio) use their live window from turn one.**

### Improved

- **`read_attachment` pages the FULL extraction** — 200K per-extractor caps gone; read_file-style
  offset/limit paging, cached extraction, shared preview whitelist, `rawBase64` bloat dropped.
- **Attached images are embedded in the message itself** — on a vision dispatch the turn's images ride
  as native image parts (≤8, ≤5MB, dispatch-only); `read_attachment` returns a native media part gated
  on result shape, vision-gated, honest placeholder otherwise. SVG returns as XML text.
- **Preflight TTFT gaps are attributable** (`gap-after-<name>`), naming every ≥50ms inter-span gap.

### Removed

- **Every dead legacy positive-id chat branch** (all live chats are negative-id stream-transport), plus
  two dead-by-flag features: auto-memory-after-stream and the post-turn self-correction husk.

## [14.8.10] (2026-07-03) — Reliable background work, one permission gate, lighter UI, sharper reasoning

Harness-refinement release from a live installed-app session. tsc/oxlint/knip clean; vitest **1576**.

### Fixed

- **The repetition guard guides instead of killing the turn** — `edit_file` keyed by full args (not
  `{path}` only, which read sequential edits as a doom loop); staged 3 (corrective result) → 6 (stronger
  steer) → 9 (tools-off force-finish).
- **grep no longer looks "stale" after the agent's own edits** — the write path upserts each written file
  into the FTS5 index; the reranker treats unindexed files neutrally; the watcher registers on workspace bind.
- **Inline chat no longer freezes after an error + model-switch continue** — every lifecycle event carries
  its leg's `streamId`; the renderer drops superseded-leg events.
- **edit_file self-heals across typographic punctuation** (curly quotes/dashes/ellipsis/NBSP normalized).
- **Sidebar "new window" opens the workspace chooser** (not a clone of the current workspace).
- **Model-driven commits carry the Atlarix co-author trailer.**
- **End-of-turn timeline no longer regroups old tool cards** (rebuild is a persistence fallback only);
  long delegations of any kind steer to `background:true` + park/auto-wake.
- **Headless tarball rebuilds automatically on every `v*` release tag.**
- **Plan progress updates are weak-model-proof** — full-plan rewrite (`operation:'write'`) is the
  canonical progress update; `update_step` prefers `step_text` and its not-found error carries the
  checklist + recovery routes inline.
- **Dead Blueprint UI surface removed** (13 `blueprint:*` channels, preload allowlist, the 430-line
  `registerBlueprintHandlers`, 3 UI-only libs) — the substrate is untouched.
- **Tool-result JSON fragments no longer leak into chat text** (orphan result tails stripped).
- **The continue-until-done gate no longer restarts finished work or hijacks Plan mode** — it doesn't
  attach in Plan mode, the nudge says "mark completed steps done, never redo", and a hard per-turn cap (12)
  bounds nudges.
- **Background/sub-agent results are delivered reliably** — the wake decision is computed up front
  (single-consumer), `background_jobs` shows the real finished output.

### Changed

- **One permission gate** — the "dangerous command" hard floor is gone; force-push / `reset --hard` /
  `rm -rf` flow through the ask / allow-once / always-allow / deny gate (amber badge, keyed per danger
  pattern, never auto-run until allowed once).
- **Reasoning scales to each model automatically** (capability-derived from the catalog channel;
  budget-capable → high/max, effort-only → medium/high).
- **Lighter UI under load** — ignore-filtered file-watcher + per-chat jotai selectors.

### Added

- **`wake_on` monitor for long-running jobs** — wakes the agent when a running job's output matches.
- **Background-job live view** — the running-tasks popover expands each job's output tail with a
  stalled/matched badge, cancel, and send-to-chat.

## [14.8.9] (2026-07-02) — Open-weight harness hardening: task-state, edit fidelity, and a sharper agent

First tagged release since 14.8.0; carries harness work 14.8.5→14.8.9. tsc/oxlint/knip clean; vitest **1525**.

### Added

- **Live task ledger + continue-until-done** — the session plan is re-surfaced compactly every turn; the
  agent keeps one step in-progress, verifies each before advancing, and drives the plan to completion
  (bounded; still stops for a decision / manual test / background work).
- **Out-of-band `<system-reminder>` framing** so a harness continuation isn't read as a fresh user request.

### Changed

- **`edit_file` collapsed to `write` + `replace`** with an opencode-style self-healing match cascade;
  over-escaped content (literal `\n`) is auto-repaired when unambiguous, hard-blocked otherwise.
- **Prompt + tool-guidance refinement** — de-duplicated triplicated mode guidance, decisive "when to use"
  moved onto tool schemas, work-mode picker shows only the five modes.
- **Token-efficient visual "sight" is more accurate** — the layout-defect check excludes
  decorative/positioned layers (no false "layout bugs").

### Fixed

- **Cancel is immediate** — stopping a turn kills sub-agent git/worktree children.
- **Actionable tool errors everywhere** — bare `{error}` returns normalized so a failure never reads as success.

## [14.8.0] (2026-06-30) — Headless preview testing, rock-steady streaming, smarter stalls

Reliability + capability pass. tsc/oxlint/knip clean; vitest **1441**.

### Added

- **Headless `preview_test` tool** — one call runs a scripted navigate→click/fill→waitFor→assert against
  the live preview and returns a structured pass/fail (reuses the offscreen `WebContentsView`, so it works
  in the packaged app; framework-agnostic). Build/Debug only.
- **Preview runtime-error completion gate** — a turn can't end "done" while the preview is
  white-screening/500ing (error console output, failed loads, dead renderer, 4xx/5xx block completion;
  benign dev warnings filtered).

### Changed

- **Idle-stall budget 300s → 600s** for open-weight reasoning models' silent think-pauses.
- **Stall recovery continues from the partial round** — completed steps captured via `onAbort` and
  replayed (no re-running every tool call).
- **Removed the redundant rolling 7-exchange session-memory summary** — context defers to the full history
  - token-overflow compaction (like opencode/Claude Code).

### Fixed

- **The streaming chat no longer jumps back** mid/end-of-stream — dynamic `overflow-anchor`, a same-frame
  `ResizeObserver` re-pin, and a scoped end-of-stream fallback.
- **Weak/local text-tool models settle cleanly** — text-tool detection runs per-delta so a prior round's
  `<tool_call>` isn't re-detected and re-executed.

## [14.7.0] (2026-06-26) — Wait-state unification: the agent waits, stops, and resumes like a real coding agent

Grew past a regression patch (14.6 fixes folded in). tsc/oxlint clean; vitest **1439**.

### Added

- **Wait is a harness property, not a prompt** — tool approvals block the turn mid-loop (the await lives in
  the tool's `execute`): Stop stays, no premature "all done", approve/deny continue the same turn.
- **Durable `waiting` status** — a parked/question turn persists as `waiting` (no migration), showing a calm
  affordance after reopen instead of the amber "interrupted".
- **The agent manages its own background sub-agents** — `task({list:true})` lists running sub-agents,
  `task({task_id,cancel:true})` hard-cancels one; live partial-output tails on status checks.
- **`schedule_wakeup` self-wake** (clamped 60–3600s; fully opt-in).
- **Atlarix Core local auto-fallback (dev-gated)** — release builds byte-identical (no-op when packaged).

### Changed

- **The agentic loop terminates on `finishReason`, not a native-message proxy** — removes a wasted extra
  round on every tool-using turn and parks detached work so the turn ends and auto-resumes.
- **Finished background results arrive as a real, persisted tool-result** (forced `collect_results` on the
  native-history channel).
- **Longer async timeouts** — sub-agent cap 5m → 10m; stalled advisory 2m → 3m.
- **Background tasks fold into one card** with a scrollable popover.

### Fixed

- **Context meter drops after compaction; reopened sessions slice correctly** (marker reliably persisted).
- **Settings permission rules now actually apply** — duplicate `apps` rows collapse onto the canonical row.
- **Edit-and-resend revert dialog returns after relaunch** (snapshot map rehydrated on session load).
- **No re-answering an already-answered question on auto-wake.**
- **Decrypt-aware provider-key check** — an undecryptable key no longer counts as "usable".

## [14.5.0] (2026-06-22) — Streaming reliability, full history, honest "Reconnecting", model-facing context meter

Reliability + fidelity pass on the chat stream and conversation surface. tsc/oxlint clean; vitest **1343**.

### Added

- **Stall auto-retry (per-round AbortController)** — a transient mid-turn stall retries the round on a fresh
  controller + reset-partial signal instead of killing the turn (slow first byte 180s vs. idle silence 45s).
- **Edit-and-resend optional file revert** — replays discarded turns' shadow-git snapshots newest→oldest.
- **Headless CI** — `.github/workflows/headless.yml` publishes the `headless-bench` prerelease tarball.

### Changed

- **"Reconnecting…" only on genuine reconnects (any provider)** — driven solely by the backend retry signal.
- **Single-flight turn guard** — at most one turn/write set per chat; a stale stream can't paint over a live one.
- **Smooth streaming render (no virtualization)** — memoized markdown segments, deferred Shiki,
  `overflow-anchor` (virtualization was prototyped and reverted).
- **Full conversation history** — 7-exchange render cap + `SESSION_LOAD_MESSAGE_LIMIT` + destructive
  200-message prune removed (no silent history loss).
- **Model-facing context meter** — shows the real dispatched size (post-compaction), so it drops after a summarize.
- **In-band file reads** — `read_file` self-paginates with stateless offset paging (disk-spill envelope dropped).
- **Review mode is read-only** — produces a change list, never edits.

### Fixed

- **Sub-agent panel ordering on native function-calling.**
- **Agent-error popups are user-only** (the error is in the tool card).
- **Background-job auto-wake end-of-turn race** — the wake lands before the turn closes.
- **Agent terminal-tab routing** — command output reaches the right-panel Terminal tab.

## [14.0.0] (2026-06-21) — Live preview control, session recordings, true background jobs, and mode-policy command safety

Major pass on the agent's execution surface. tsc/oxlint clean; vitest **1326**.

### Added

- **`target:"preview"` — the agent drives the LIVE app** — `browser_navigate`/`browser_inspect`/
  `browser_interact` act on the running dev server (snapshot refs, click/fill, console errors) via a real
  `WebContentsView`.
- **Inline preview artifact in chat.**
- **Session recordings (scrubbable reels)** — browser/preview activity captured off-screen as a frame
  manifest, rendered as a scrubbable player.
- **`background_jobs` tool + true background lifecycle** — list/output/cancel detached commands;
  `run_command({background:true})` returns a `job_id`; any command still running after ~15s auto-moves to
  the background.
- **Auto-wake when idle** — a finished backgrounded job re-engages the agent (no polling).
- **Generic localhost-URL → preview** auto-load.
- **Local-build auto-resign** — `postPackage` ad-hoc re-signs + clears quarantine on macOS local builds.
- **Launchpad help pages** (`/docs/*` on atlarix.dev).

### Changed

- **Preview: iframe → `WebContentsView`** (native navigation/console/error capture; off-screen
  `capturePaintable` fixes black frames when unfocused).
- **Terminal output streams inline** with a live activity pulse; sequential foreground commands reuse one
  Agent tab.
- **Capability-based vision gate** — `detectVisionCapability` replaces the hardcoded 3-provider allowlist.
- **Command persistence + safety overhaul** — removed the kill-timeouts + fake "dev server started";
  safety is now mode policy + a compound-aware `isMutatingCommand` backstop + the dangerous-commands gate
  - `.atlarix/permissions.json` (no large hardcoded classifier).
- **Readable, arg-aware tool cards.**
- **AGENTS / mode prompts realigned** to the real tool surface.
- **Rate-limit error card links to troubleshooting** (no upgrade button).

### Fixed

- **Provider-agnostic `web_search` dedup** — the xAI/Grok `Duplicate tool names: web_search` crash.
- **`browser_interact` fill reliability** (schema emphasizes `value` is required).
- **Empty preview frames** when the preview tab isn't focused.
- **Dev servers dying after ~10s / fake "running in background"** — removed in the persistence overhaul.

## [13.9.0] (2026-06-19) — Reliability pass: terminal reuse, live plan preview, steadier long runs, robust sign-in, tidy file tree + accurate diffs, self-review, cross-platform updater

- AI terminal reuses one persistent "Agent" tab for sequential foreground commands (background processes still get their own tab).
- Plan writes stream live, and long turns no longer show a false "stopped/Reconnecting…" (activity pulse on tool start + every ~15s, 20s reconnect window).
- Sign-in survives relaunch: startup session restore retries secure-storage reads and token refresh with backoff.
- Code tab file tree hides `.git`/`.vscode`/`.idea`/`node_modules` and gitignored files.
- PostHog activation-funnel events shipped (`app_opened`, `model_connected`, `first_task_started/completed`, `task_completed`).

## [13.9.0-pre] — Airtight overwrite diffs, on-disk edit self-review, and a real cross-platform auto-updater

- Auto-approved overwrites now render accurate red/green diffs via a display-only `chat:stream:write-preview` event, at zero model tokens.
- Edits self-review against disk after each write; a single consolidated review fires at the `task_complete` gate only if an edit didn't verify.
- Background auto-updater works on all platforms with errors surfaced in a new Settings → Updates diagnostics panel.
- `docs/harness-comparison.md` rewritten (verdict: the open-weight frontier workstation).

## [13.8.1] (unreleased) — Zero-token, accurate file diffs (display-only, never re-sent to the model)

- Write/edit diff cards no longer echo file content into the model transcript (the tool-call args already contain it once).
- Diffs render from a display-only source (tool-call args + full uncapped old/new from the permission preview) that survives reload — including full overwrites — at zero model-token cost.

## [13.8.0] (unreleased) — One file-mutation tool, fewer browser tools, no more false "Reconnecting…"

- `write_file` merged into `edit_file` (`operation:"write"`) — one file-mutation tool for create/overwrite plus surgical ops.
- Browser tools consolidated 6 → 3 (`browser_navigate`/`browser_inspect`/`browser_interact`); net agent surface 24 → 20.
- Live streaming preview for file writes, a visible AI cursor in the browser, and a browser session-record timeline artifact.
- `git init` allowed by default; `glob` and ignore rules now honor `.gitignore` (incl. monorepos) + `.atlarixignore`.
- Fixed false "Reconnecting…" during long writes plus persistent `run_command`/write diff cards.

## [13.7.0] (2026-06-18) — Blueprint becomes the silent grep substrate, `@` mentions as chips, fewer Supabase pings, editable plans, a hardened agent loop + headless CLI

- `get_blueprint` tool removed; the Blueprint index now silently reranks every `grep` and powers edit-time blast-radius.
- `@` file/folder mentions render as removable chips; plans are editable before and during a build.
- `task_complete` completion tool replaces the text sentinel; edit + `run_command` mutation verifiers block a premature finish.
- Headless Electron-free agent CLI + benchmark harness (Terminal-Bench / SWE-bench).
- Fewer Supabase pings (TTL-cached tier/subscription); OAuth tokens no longer logged; MCP env vars encrypted at rest.

## [13.6.0] (2026-06-16) — Surface simplification: scoped `@` mentions, tiers collapsed to Core 1–4, deploy connectors removed, Review absorbs security

- Model tiers collapsed to four individual Core models (Core 1–4); every plan can use every model.
- Scoped `@` file/folder mentions in the current workspace replace the whole-codebase dump.
- Deploy connectors (Supabase/Neon/Vercel/GitHub Actions) removed for a terminal-first + MCP-only flow; the `/` slash-command system deleted.
- Review mode absorbs the standalone security-review.
- Live BYOK context limits, a session-resume prompt, and one-click MCP OAuth marketplace connect.

## [13.5.0] (2026-06-13) — Open-weight Core providers, disk-backed FTS5 retrieval, writer sub-agents, real Windows sandbox

- Open-weight Core providers — DeepSeek, Qwen, Kimi, MiniMax — with model lists from the live models.dev catalog.
- Disk-backed SQLite FTS5 lexical index (scales to any repo, kills OOM) plus symbol-aware `grep`.
- Writer sub-agents run in isolated git worktrees (`task({ write: true })`); real Windows AppContainer sandbox helper.
- Microcompact drops stale tool outputs without an LLM call; verifiable browser session-recording + a11y-ref tools.
- Removed the on-device Model2Vec/semantic-embedding lane (−62 MB) and the capability-TRIM stage.

## [13.1.5] (2026-06-12) — Open-weight harness hardening: command sandbox, parallel-research orchestration, Hugging Face, Blueprint-backed grep

- Per-OS write-confining sandbox for `run_command` (macOS Seatbelt, Linux bubblewrap, Windows AppContainer).
- Background sub-agents with wait / work-while-waiting orchestration that folds each result into the turn as it finishes.
- Hugging Face BYOK provider.
- Blueprint is the always-on retrieval substrate behind `grep`; message order preserved after streaming; command/file cards paginate.
- Integration commit "making atlarix a proper harness v1" (tools 38→22, one parallel `task`, background commands).

## [13.0.0] (2026-06-12) — v13 mass simplification (shipped in the 13.1.5 release)

- Tool surface cut opencode-minimal from 38 → 22.
- One `task` tool with up to 5 parallel sub-agents; `plan` collapsed to one tool.
- Removed project templates, the Activity/Agents tabs, the background-agents feature, and ALL LSP (model-facing + editor).
- Background commands (`run_command({ background: true })`) with a visible waiting state and one queued follow-up.
- Tool result cards show the work by default; AGENTS.md/CLAUDE.md interop; a "revert this turn's file changes" checkpoint.

## [12.10.0] (2026-06-09) — streaming-UI crash fixes + runtime Core models + project-check verification

Runtime Core-tier model config via a hosted core-models.json (no repackage), Build/Debug verify with the project's own tooling, and fixes for a plan-panel render loop, vanishing edit cards, and quit-time crashes.

## [12.9.7] (2026-06-09) — ask_user options render correctly + de-hardcoded context-window logic

ask_user option objects render correctly (no more `[object Object]`), proposal token-usage uses the real per-model context window, and stale context-window fallback heuristics were modernized.

## [12.9.6] (2026-06-09) — Terminal actually opens now (correct asar unpack key)

Fixed the packaged Terminal ("posix_spawnp failed") by unpacking node-pty's `spawn-helper` via the correct electron-forge `packagerConfig.asar.unpack` key.

## [12.9.5] (2026-06-09) — Terminal now opens in packaged builds

First attempt to fix the packaged Terminal shell by asarUnpack-ing node-pty's native `spawn-helper` (superseded by 12.9.6's correct key).

## [12.9.0] (2026-06-09) — Fix fatal Terminal crash (removed keytar) + packaged system prompt

Fixed a fatal Terminal crash by replacing keytar with Electron safeStorage, and shipped the full AGENTS system prompt in packaged builds.

## [12.8.0] (2026-06-08) — Stability: graceful token count, delete-session keeps you in the workspace, crash hardening

Graceful token-count for torn-down chats, deleting the active session keeps you in the workspace, and an `uncaughtException` handler prevents fatal native aborts.

## [12.7.0] (2026-06-08) — Tool-schema sanitizer (fixes strict-provider 400s), tidier chat config, quieter Sentry

A tool-schema sanitizer fixes strict-provider 400s, tools with hand-written parameter maps send their real params, and benign empty-output stream errors are dropped from Sentry.

## [12.6.0] (2026-06-08) — Sign-in fix: Google & GitHub buttons everywhere, log out/in from the welcome screen

Restored real "Continue with Google/GitHub" sign-in buttons everywhere and added log out / sign in directly from the welcome screen.

## [12.5.0] (2026-06-08) — Concurrency & stability: run sessions in parallel, never lose work, keep going while the screen sleeps

First tagged release: concurrent session tabs, interrupted-turn recovery with Continue, keep-working-while-the-display-sleeps, and a switch-provider prompt on Core exhaustion.

## [12.0.0] — Unreleased (pending manual test): The engine release — one agent loop, native tool history, verified edits, background agents

The engine release: one unified `runAgentTurn` loop, native tool-call history, in-loop edit verification, per-model capability profiles, portable permissions/hooks, user-defined agents, background agents, and Blueprint v2.

## v11.0.0 work — included in 12.0.0 above (never tagged separately): In-app browser, WebMCP, Atlarix Core, document readers, much lighter app

The v11 batch folded into 12.0.0: an in-app Chromium browser (WebContentsView) the agent can drive, WebMCP page tools, Compass renamed to Atlarix Core (four token-metered models, no tier gating), more document readers, system git instead of bundled dugite, and a much lighter package.

## [10.1.0] (2026-06-04) — Inline streaming indicator, native web search, prompt caching, interactive questions, lighter app

Inline streaming compass indicator, provider-native web search, prompt caching, interactive ask_user question cards, Cmd/Ctrl+P quick-open, and a much lighter app (~28 deps removed).

## [10.0.0] (2026-06-04) — Interactive terminal, live plan progress, per-hunk approvals, memory.md

Interactive PTY terminal, live plan step progress, per-hunk diff accept/reject, `.atlarix/memory.md`, a first-run setup wizard, and content-addressed shadow-git snapshots.

## [9.1.1] (2026-05-29) — Inline chat tools, permissions, build fixes

Inline chat tool cards and diffs via the IPC stream thread, workspace command/file permission stores with a Settings UI, and merge/build regression repairs.

## [9.1.0] (2026-05-28) — Streamline, attachments, LSP

Workspace file/command permissions with approval scopes, post-send attachment chips with persistence, bundled LSP servers, and folder-required GitHub clone.

## [9.0.0] (2026-05-28) — Welcome launcher hotfix

Fixed the renderer `node:path` import on Open-folder and hid panel chrome until a workspace is selected.

## [8.9.0] (2026-05-27) — Workspace-first product & release polish

Workspace-first product: removed global chat/MCP/skills and the Prompt Library, added the welcome launcher, background sessions, and Explore/Review-only sub-agents.

## [8.8.0] (2026-05-26) — Plan artifacts, session titles, folder picker

Plans stored as SQLite artifacts with a plan→building→built lifecycle, AI-generated session titles, and an immediate native folder picker on add-workspace.

## [8.7.5] (2026-05-24) — Polish & UX

Renderer IPC bridge dedupe, packaged-logo asset fix, workspace-delete cleanup, on-demand file-tree loading, and diagram/Mermaid render polish.

## [8.7.4] (2026-05-24) — Packaged ast-grep native binding hotfix

Stopped a post-install prune from stripping `@ast-grep/napi` platform bindings and staged Python/Go grammars via `extraResource`.

## [8.7.3] (2026-05-24) — Packaged Blueprint crash fix & smaller asar

Fixed a packaged Blueprint crash by unpacking ast-grep `parser.so` grammars, and shrank the asar (production source maps and dev deps stripped).

## [8.7.2] (2026-05-24) — Stability & package size

Enforced section-scoped Blueprint (reject workspace-root `focus_path`), added crash diagnostics, and shipped smaller installs via system git and pruned duplicate trees.

## [8.7.0] (2026-05-24) — Section-scoped Blueprint

Section-scoped Blueprint: `get_blueprint` requires a `focus_path` with did-you-mean suggestions, plus a slice layer and a richness-gated hybrid merge.

## [8.6.5] (2026-05-23) — Windows file-discovery path fix

Normalized `fd`/`rg --files` paths to workspace-relative posix so ctags indexing no longer returns 0 symbols on Windows.

## [8.6.4] (2026-05-23) — Windows ctags index fix

Fall back to a recursive scan when discovery returns no paths and normalize ctags `-L` file-list paths to forward slashes.

## [8.6.3] (2026-05-23) — Windows CI ripgrep

Install ripgrep via Chocolatey in Windows CI so blueprint indexing uses `rg --files` instead of the legacy recursive scan.

## [8.6.2] (2026-05-23) — Atlarix Core build embed fix

Fixed Atlarix Core "Not Setup" in release builds by using static `process.env.COMPASS_*` reads so Vite inlines the CI secrets.

## [8.6.1] (2026-05-23) — Packaging & release hotfix

Stopped `packageAfterPrune` from skipping `@ast-grep/napi` platform optionalDependencies (fixed the "Cannot find native binding" startup crash) plus Windows/Discord CI fixes.

## [8.6.0] (2026-05-22) — ctags + ast-grep Blueprint stack

New ctags + ast-grep Blueprint stack: lazy-load generation, route/structural edges, a worker pool, incremental per-file refresh, and blast-radius.

## [8.5.2] (2026-05-21) — Agentic stream completion

The Build loop no longer ends on prose-only replies, completion requires an explicit `<task_complete>`, and the 60s pending-tool stall abort was removed.

## [8.5.1] (2026-05-21) — Hotfix

Removed a stale `useStreamChat` dependency causing a startup ReferenceError and restored long-form `</think>` reasoning dedup.

## [8.5.0] (2026-05-20) — Single ask path, terminals, sessions, packaging

Single `ask_user` question path, a multi-terminal Activity panel with persistence, workspace sessions, and renderer packaging shims.

## [8.4.2] (2026-05-19) — Patch

Renderer Vite shims in progress toward the 8.5.0 packaging fixes.

## [8.4.0] (2026-05-17) — Terminal, CLI, modes, and session fixes

Terminal reliability, an `atlarix` CLI open flow, per-mode system prompts with terminal permissions, PDF attachments, and per-message work mode.

## [8.3.1] (2026-05-17) — Chat config dropdown placement

Chat config/model/work-mode menus open above the composer with Radix collision avoidance so they no longer clip below the viewport.

## [8.3.0] (2026-05-17) — Agent Workstation reframe

Agent Workstation reframe across product copy; removed `git_status`/`git_diff`/`git_log` tools in favor of the terminal, and strip raw `<task_complete>` tags before render.

## [8.2.0] (2026-05-15) — Parser worker pool, WASM tree-sitter, packaging fix

A parser worker pool, WASM tree-sitter for Python/Go/Rust, and an oxc packaging fix that keeps `@oxc-parser` bindings.

## [8.1.1] (2026-05-15) — oxc-parser, repo overview, secret path hardening

oxc-parser for TS/JS/JSX/TSX, a `get_repo_overview` orientation tool, and an extended secret-path denylist with workspace-escape blocking.

## [8.1.0] (2026-05-11) — Pass 6: Blueprint restoration, unified search, streaming, tool merge

Restored the Blueprint lazy-parse graph, a unified `search` tool, throttled/virtualized streaming chat, and consolidated several tools.

## [8.1.0] (2026-05-09) — Pass 7: Blueprint removal + tool consolidation

Intermediate branch (superseded by Pass 6): removed the Blueprint subsystem, consolidated tools ~60→28, MCP on-demand scoping, and migration 0043.

## [8.0.4] (2026-05-07)

Windows/symlink permission-safe file discovery (skip EACCES/EPERM), renderer memory-pressure guards (V8 old-space + serialized scans), and RSS logging.

## [8.0.3] (2026-05-07)

First-class OpenRouter BYOK provider plus Electron packaging robustness (externalized tokenizer/pdfjs, node-pty rebuild, larger Vite heap).

## [8.0.1] (2026-05-07)

Tool Contract Layer, model-triggered `compress_context`, an idempotent stream terminal, macro tools, BYOK error banners, a Skills Marketplace, and heavy context cleanup (~50% lower baseline tokens).

## v7.1.4 — Stepped compaction, exact tokenizer, icon fix (2026-05-06)

Stepped OpenCode-pattern context compaction, exact `@anthropic-ai/tokenizer` token counting, an all-modes `compress_context` tool, and DMG/Windows/Linux installer icon fixes.

## v8.0.0 — Model-driven exploration, LSP diagnostics, OpenCode parity (2026-05-06)

Model-driven workspace-exploration tools, LSP diagnostics injection across 15+ languages with `apply_lsp_fix`, and a lazy 4-strategy file-discovery architecture.

## v7.1.2 — Token efficiency, architecture improvements, terminal enhancements (2026-05-05)

OpenCode-parity cache-aware token management and turn-based compaction, new logging/error/context/plugin services, doom-loop detection, and PTY support.

## v7.1.1 — No-workspace CTA hides after first message in chat-only threads (2026-05-03)

The no-workspace "Open workspace" CTA now hides after the first user message in chat-only threads.

## v7.1.0 — Agent bus oversight, counsel completion-driven flow, diagram polish, first-run UX (2026-05-03)

Agent-bus delegation oversight (cyclic/runaway detection), completion-driven counsel via `Promise.allSettled` with a 7-minute cap, Mermaid prompt rules, and sign-in/onboarding UX polish.

## v7.0.9 — ask_user ordering, quieter IPC logs, stream while question pending (2026-05-01)

Fixed ask_user Q/A bubble ordering, kept assistant continuation streaming while a question is pending, and made IPC success traces opt-in.

## v7.0.8 — Sentry hygiene, bundled TSC worker, clarifying questions (2026-04-30)

Sentry auth-noise hygiene, an external TSC worker that resolves the project's compiler first, and clarifying `<questions>` support across chat-only/ephemeral paths.

## v7.0.7 — Windows release upload URL encoding (2026-04-30)

URL-encode the `name=` param on Windows release-asset uploads so filenames with spaces upload correctly.

## v7.0.6 — New providers, Windows CI, remove Auto button (2026-04-30)

Added NVIDIA NIM, Cohere, Perplexity, and Cerebras providers with model browsing, enabled the Windows CI build, and removed the Auto mode button.

## v7.0.5 — Auto-updater: macOS ZIP feed + Linux deb/rpm update notification (2026-04-27)

Auto-updater support: a macOS stapled-ZIP feed and Linux deb/rpm update notifications (AppImage stays on electron-updater).

## v7.0.4 — Chat config panel never clips + agent cannot read .env\* files (2026-04-26)

The chat config dropdown always opens below the trigger without clipping, and `read_file` now blocks `.env*` secret basenames.

## v7.0.3 — Sign-in reliability + clearer dark mode (2026-04-24)

Restored external-browser Supabase OAuth with a 60s timeout/Copy-Link fallback, aligned free-tier copy, and improved dark-mode contrast.

## v7.0.2 — Chat strip labels, counsel/deep-think UX, turn artifacts (2026-04-20)

Provider-agnostic tool/working strip labels from a stable `toolId`, a counsel deep-think substitute for models without native reasoning, and per-message Counsel/agent-bus turn artifacts.

## v7.0.1 — Deep research ledger + web relevance (2026-04-17)

`deep_research` gains a research-ledger agentic loop with semantic stop conditions and tuned web-relevance thresholds.

## v7.0.0 — Atlarix v7 (Project Vanguard) (2026-04-11)

Atlarix v7: skills-driven mode/specialist behavior, a disk-backed task ledger, living plan sync/archive, and a renderer plan viewer built on the Blueprint foundation.

## v6.5.0 — Project Vanguard (2026-04-09)

Living `.atlarix/ATLARIX_PLAN.md` aligned to the task ledger with plan archiving, counsel IPC (start/cancel/update), and audited provider-agnostic task flow.

## v6.2.2 — Tier-aware Compass context + pre-dispatch budgeting (2026-04-09)

Tier-aware Compass context using dynamic OpenRouter `context_length` limits and pre-dispatch budgeting for the Balanced and Thinking tiers.

## v6.2.1 — Autonomous session polish + Thinking UI + snapshot hash path (2026-04-08)

Autonomous Build agent-mesh polish (auto-approve, agent bus, review panel), a Thinking card + activity stream, and a canonical `snapshot_hashes.json` layout.

## v6.2.0 — Unified workspace snapshots + non-destructive revert (2026-04-08)

Unified workspace snapshots with non-destructive revert (`is_reverted` markers), removed the internal diagram git, and Blueprint-canvas performance work.

## v6.1.16 — Diagram stability + Compass context safety (2026-04-08)

Diagram stability (deterministic file-tree layout, history restore), Compass/OpenRouter context safety near the limit, and streaming long-running-command terminal output.

## v6.1.15 — Safety: Compass network noise, SQL guards, prompt hygiene, profanity filter (2026-04-07)

Safety pass: transient Compass network-failure handling, SQL execution guards, entry-point prompt hygiene, and a list-based profanity filter.

## v6.1.14 — Groq external auto-router classifier, balanced baseline, tier floors (2026-04-07)

An external Groq auto-router classifier with a confidence chain, a balanced (never-fast) baseline, and tier floors for main-agent plan/build/debug work.

## v6.1.13 — Linux OAuth fallback, theme toggle, contrast fixes, auto-updater in-app UI (2026-04-05)

Linux OAuth timeout/Copy-Link fallback, a Settings theme toggle, WCAG contrast fixes, an AppImage target, and an in-app auto-updater banner.

## v6.1.12 — Mermaid normalize (diagram page + AI output) (2026-04-04)

Mermaid normalization for the diagram page and AI output (fixes "No diagram type detected") with clean remounts on diagram switch.

## v6.1.1 — Diagram git ignore, blueprint ELK first paint, dev-server preview (2026-04-04)

Diagram-git ignore fix for `userData`/`.cursor`, Blueprint ELK first-paint dedupe, and a dev-server preview URL fallback.

## v6.1.0 — Main `raw-sql` transform, pivot + prompts migrations (2026-04-02)

A Vite `raw-sql` transform plugin for embedded migrations, plus new pivot-tables and prompts-schema Drizzle migrations.

## v6.0.3 — Main Vite `?raw` SQL for embedded migrations (2026-04-02)

Briefly used `assetsInclude` + `?raw` path-checked SQL for embedded migrations (superseded by v6.1.0's transform).

## v6.0.2 — Workforce workspace UI, FallbackModel doGenerate (2026-04-02)

Workforce is treated like Pro for the add-workspace affordance, and `FallbackModel.doGenerate` fixes Auto-wrapped AI diagram generation.

## v6.0.1 — Reasoning stream closure, thinking-tag hygiene, agent docs (2026-04-02)

Reasoning-stream closure on `reasoning-end`, thinking-tag hygiene/dedup, an 8192 max-output-tokens floor, and updated AGENTS prompt bundles.

## v6.0.0 — Workforce session scope, autonomous agents, UX hardening, Thoughts & routing (2026-04-02)

In-memory-per-chat Workforce session scope with a tool gate, auto-executing nested autonomous sub-agents, onboarding/UX hardening, and a Thoughts panel with an async auto-router.

## v5.2.3 — Linux launch, OAuth, and local-model reliability (2026-04-01)

Linux launch reliability (disabled Chromium sandbox, scheme-handler parity), tighter deep-link OAuth handling, and centralized PATH refresh for local models.

## v5.2.2 — Rename reserved `type` columns in SQLite graph tables (2026-04-01)

Renamed reserved `type` columns in the SQLite pivot/diagram tables to `node_type`/`edge_type`/`diagram_type`, fixing packaged-build query crashes.

## v5.2.1 — Supabase OAuth browser-open fallback (2026-03-31)

Wrapped Supabase OAuth `shell.openExternal` in try/catch with a Linux Copy-Link fallback dialog to avoid silent sign-in failure.

## v5.2.0 — Embedded SQLite migrations (2026-03-31)

Replaced filesystem Drizzle migrations with embedded SQL bundled into the main process, with a SHA-256 bridge for legacy `__drizzle_migrations` rows.

## v5.1.5 — Move ensure\* safety nets after migrate() (2026-03-31)

Moved all `ensure*` table-bootstrap calls to run after `migrate()` so fresh-DB migrations don't collide with pre-created tables.

## v5.1.4 — SQLite auto-recovery on bad local DB (2026-03-31)

SQLite auto-recovery: verify core tables after `migrate()` and wipe/retry initialization once on a corrupt or partial local DB.

## v5.1.3 — Packaged app: Drizzle migrations path (2026-03-30)

Bundle `drizzle/` via `extraResource` and resolve the migrations folder across candidate paths so packaged builds actually run migrations.

## v5.1.2 — Verified Drizzle journal seed + maintainer docs (2026-03-30)

Seed `__drizzle_migrations` rows only when each journal migration's effects are detectable, preventing partial-schema installs from skipping migrations.

## v5.1.1 — SQLite MCP tables bootstrap (2026-03-30)

Bootstrap the missing `mcp_servers` and `mcp_tool_consents` tables when a seeded journal caused Drizzle to skip migration 0012.

## v5.1.0 – Compass, usage limits, onboarding (2026-03-29)

Introduced the Compass managed cloud provider (OpenRouter-backed) with Supabase monthly token accounting, a usage strip/exhausted state, and post-login onboarding.

## v5.0.0 – Blueprint context & memory (2026-03-26)

Tiered Blueprint prompt injection, project snapshots/memory tables, end-to-end `.atlarixignore`, Ask/Plan/Build/Debug/Review work modes, and Auto routing.

For detailed historical notes (v1.x–v4.x) and implementation phases, see [`docs/previous-versions.md`](previous-versions.md) and the v5.0 tables in [`docs/TODO.md`](TODO.md).

## Atlarix product summary (for model and blueprint accuracy)

Reference: PIVOT (Code↔Canvas via Containers and Beacons), the Blueprint living diagram (RTE + RAG), Ask/Build modes with an approval flow, Research/Architect/Builder/Reviewer agents with Guided/Autonomous delegation, Fast/Balanced/Thinking tiers, and per-provider workspace token budgeting.

## v4.3.0 — UX and workflow update (2026-03-23)

Batch workforce-permissions panel, an Ollama recommender, stricter read-only Ask vs Build separation, and session-persistence/subscription fixes.

## v4.2.0 — Bug fixes and security (2026-03-18)

Bug fixes and security: fully visible onboarding buttons, a simpler more secure sign-in flow, and broad stability/compatibility improvements.

## v4.0.0 — Workforce (2026-03-16)

Workforce tier ($79/mo): teams and seats, MCP-configured integrations with agent auth, Workspace Context, Workforce extensions (Slack/Jira/Linear/Sentry/GitLab/Bitbucket/…), and progressive tool reveal.
