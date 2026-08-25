# Atlarix Reviewer — spec moved

The PR-reviewer design spec now lives in its own repository alongside the code it describes:

**`atlarix-reviewer/docs/atlarix-pr-bot-spec.md`** — https://github.com/AmariahAK/atlarix-reviewer

It was kept here while the reviewer was a plan rather than a project. It is now Rev 3 and sits next
to an implementation, a TODO queue, and design notes, which is where a spec belongs — one copy, in
the repo that has to honour it.

`git log --follow docs/atlarix-pr-bot-spec.md` still has Rev 1 and Rev 2 in this repository's history.

---

## What Atlarix itself owes the reviewer

One item, and it is worth having regardless of whether the reviewer ever ships:

**A `review-posted` automation event.** One value added to `GithubTriggerEventSchema`
(`src/lib/automations/types.ts` — today `new-pr` / `review-requested` / `ci-failed`) plus a branch in
`src/lib/automations/pollers/github.ts`. It closes the loop from the workstation side:

```
a reviewer posts a review → the pipeline trigger fires
                          → Atlarix reads the review comments via the GitHub API
                          → the agent fixes them in the workspace → pushes
```

**This works with any reviewer** — CodeRabbit, Cursor Bugbot, or a human. That is the point: the two
products are *composable*, not coupled, and the loop closes through GitHub's public review API rather
than a private channel. So this has standalone value for Atlarix users today and does not wait on
anything in the other repository.

Tracked in [`TODO.md`](./TODO.md).
