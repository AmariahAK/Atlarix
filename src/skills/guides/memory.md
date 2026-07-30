# Project memory

Notes you keep about **this** project, so a later session starts with what you learned
instead of re-deriving it. Read this only when you're about to write or reorganise a
note — the index in your context is enough to *read* one.

## Where it lives

```
<memory dir>/                 (path shown in your context; outside the repo, per-project)
  MEMORY.md                   the index — ONE line per note
  <note-name>.md              one note = one fact
```

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
