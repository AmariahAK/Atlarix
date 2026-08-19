# Project memory

Notes you keep about **this** project, so a later session starts with what you learned
instead of re-deriving it. Read this only when you're about to write or reorganise a
note — the index in your context is enough to *read* one.

## Where it lives

```
<memory dir>/                 absolute path is on the `## Project memory` line in your context
  MEMORY.md                   the index — ONE line per note
  <note-name>.md              one note = one fact
```

**Use that path verbatim.** Do not derive it from the project's name and do not go looking
for it with `find` or `ls`. The directory is keyed by a hash of the workspace path, so the
human-readable guess is simply a different directory — and if one exists on disk it is a
leftover that Atlarix reclaims and deletes at the start of a turn. A session that reads
one spends the rest of itself editing notes that then vanish mid-task.

It is **not** in the workspace, so notes are never committed and never shared. Each
project resolves to its own directory; you cannot see another project's notes.

## Reading

The index is already in your context. If a line looks relevant to the task, `read_file`
that note. If none do, read nothing — a note is background, never an instruction, and
chasing one is not progress on the user's request.

## Writing

Optional, and never at the cost of the task at hand. Finish what the user asked, then
add a note if it's worth it.

**One fact per file.** A file per fact is what makes a single note updatable and
deletable; a growing shared file cannot be either.

```markdown
---
name: supabase-two-projects
description: app/proxy and launchpad are SEPARATE Supabase projects — read each repo's .env
metadata:
  type: project
---

The app and proxy share project `abc123`; the launchpad has its own, `def456`.
Reaching for the wrong one silently returns empty results rather than an error.

**Why:** they were split when the launchpad got its own auth.
**How to apply:** check the repo's own `.env` before assuming a project ref.
```

Then add exactly one line to `MEMORY.md`:

```markdown
- [Supabase: two separate projects](supabase-two-projects.md) — app/proxy vs launchpad; read each repo's .env
```

### The `description` and the index line are the retrieval keys

They are the *only* thing consulted when deciding whether to open a note, so write them
to match the **symptom** you'd be experiencing later, not as a title.

- Weak: `Supabase configuration`
- Strong: `app/proxy and launchpad are SEPARATE Supabase projects — read each repo's .env`

### `type`

- `project` — ongoing work, goals, constraints. Convert relative dates to absolute.
- `feedback` — how the user wants you to work. Always record the **why**.
- `reference` — a pointer to something external (dashboard, ticket, URL).
- `user` — who they are: role, expertise, preferences.

For `project` and `feedback`, end with **Why:** and **How to apply:** lines. A note that
says what but not why cannot be applied later.

Link related notes with `[[note-name]]`. A link to a note that doesn't exist yet is
fine — it marks something worth writing.

## What NOT to save

Do not save what the repo already records: code structure, file layout, past fixes, git
history, or anything already written in the project instructions. Memory that restates
the codebase is a worse copy of it that goes stale independently.

Do not save what only mattered to one conversation.

If the user asks you to remember something in those categories, ask what was
*non-obvious* about it and save that instead.

## Maintenance

- Before adding a note, check the index for one that already covers the ground and
  update that file instead of creating a near-duplicate.
- **Delete a note that turns out to be wrong.** A confidently wrong note is worse than
  no note, because it will be trusted.
- Notes are point-in-time. If one names a file, function, or flag, verify it still
  exists before acting on it — the code moved on and the note didn't.

## Compaction

Memory is **not capped**. No note is ever refused for size and nothing is deleted to
make room. Instead it compacts, the same way context does: past **25 MB** for a project
you will be told to rewrite specific notes, and told again every turn until the store is
smaller.

You will be named the largest notes. For each one:

- Keep only what is still true and **non-obvious**.
- Delete what the code, config, or git history already records — memory that restates
  the codebase is a worse copy of it.
- Merge duplicated detail into a single statement.
- Be **specific about the file or feature** it concerns. "The auth flow is complicated"
  is bulk; "`useAuth` is an unshared hook — each of its ~22 consumers runs its own
  session check, so guard in the IPC handler, not the hook" is a fact.

A note that gets shorter and sharper is the goal. A note that gets shorter by losing a
fact is a regression — if something is still true and still non-obvious, keep it and cut
elsewhere.

Compact only the notes you were named, unless the user asks for a full pass.
