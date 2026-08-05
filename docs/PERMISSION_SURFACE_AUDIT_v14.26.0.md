# Permission surface audit — v14.26.0

**Report only. No code changed for this document.** Same contract as
`PROMPT_SURFACE_AUDIT_v14.23.0.md`: findings and measurements, acted on in a later release,
deleted once acted on.

## Why this exists

Owner's question, 2026-08-05: *"for all our sandbox security, we copied codex & claude code …
I was asking if maybe we are overcomplicating security based off of this … I believe we may
have too many conflicting things or doing the same thing."*

Fair question to ask of ~5,300 lines across 16 modules. The precedent for answering it well is
v14.23.0's protected-path deletion: that list went because it duplicated a decision the
approval queue already made, and nothing was traded away because the real gate stayed. So the
test applied throughout here is not "is this complex?" but **"which mechanism actually answers
this question, and does anything else answer the same one?"**

Note the axis. The 2026-08-05 hardcoding sweep already reviewed the *lists inside* these gates
(`defaultWritablePaths`, `DANGEROUS_PATTERNS`, `SYSTEM_SCOPE_PATTERNS`, `DENIAL_PATTERNS`) and
found four of them correct as-is. This audit is about overlapping **mechanisms**, which is a
different question, and it does not re-litigate those.

## Headline

**The surface is layered, not duplicated.** I went in with four duplication hypotheses and
**all four were refuted by the code.** Every mechanism examined answers a question no other
mechanism answers, and in the two places where two gates look alike, the modules already say
in their own headers which one is the boundary and which one is UX.

That is the honest answer to the question, and it is worth stating plainly because the
expected answer was the opposite.

**Two real findings did come out of it, and neither is duplication:**

1. **`ask` rules in `.atlarix/permissions.json` are compiled, matched, logged — and never
   enforced.** A documented v1 scope note that became a shipped half-feature.
2. **Complexity is concentrated, not spread.** `interceptor.ts` is 2,127 lines — 40% of the
   whole surface in one file. If anything here is "overcomplicated", it is that file's internal
   structure, and no amount of deleting *modules* touches it.

---

## The four hypotheses, and how each died

### H1 — `guard.ts` / `file_permission_preflight.ts` / `file-permission-scope.ts` are three modules doing path+arg analysis ahead of the same decision

**Refuted, and the premise was wrong about one of them.**

`guard.ts` **is not a permission mechanism at all.** It does JSON-schema required-field
validation, a `TOOL_ERROR` catch so no tool throws to the caller, Sentry breadcrumbs, and
`canonicalizeParamAliases` (`file_path`/`filePath`/`filename`/`file` → `path`). It touches
`__permission_required` markers only to pass them through untouched. It is filed under
`lib/tools/` next to permission code and the name invites the confusion, but it decides nothing
about access.

The other two are a **resolver and its adapter**, not two resolvers:

| module | role |
| --- | --- |
| `file-permission-scope.ts` | pure functions. Given a relative path, an operation, and the workspace's stored rows, return `auto_allow` / `auto_deny` / `prompt`. No I/O. |
| `file_permission_preflight.ts` | the stream-side caller. Runs the resolver, emits activity/blocked events, shapes the approval card, and partitions a `write_multiple_files` batch into auto-allow / auto-deny / prompt. |

One resolver, one adapter, one unrelated module. Nothing to merge.

### H2 — `.atlarix/permissions.json` vs. stored `always_allow`/`always_deny` rows vs. `.atlarix/hooks/` are three ways to say "ask / deny this"

**Refuted as duplication — but this is where finding #1 lives.**

They are three different *authorities*, and `ruleset.ts`'s own header already draws the line:
*"AUTO-ALLOW already exists as the per-workspace command/file permission stores … this file
does not duplicate them."*

| authority | who writes it | where it lives | when it runs |
| --- | --- | --- | --- |
| `.atlarix/permissions.json` | a human, committed to the repo | file, workspace + global `~/.atlarix` | at the tool funnel, before execution |
| stored permission rows | the user, by clicking a card | SQLite, per workspace | during the approval flow |
| `.atlarix/hooks/` | a human, executable | `/bin/sh -c` per tool call | at the tool funnel, before execution |

A committed team policy, a remembered personal decision, and an escape hatch that can run
arbitrary logic. Removing any one loses something the others cannot express.

### H3 — `dangerous-commands.ts` + `system-scope-commands.ts` duplicate the OS sandbox

**Refuted, and both modules already say so in their headers.**

`system-scope-commands.ts`: *"The real enforcement boundary is the per-OS write-confining
sandbox (see lib/sandbox/wrap-command.ts). **This module drives the ASK, not the boundary.**"*

They are also not duplicates of *each other* — they answer two different questions:

- **dangerous** = destructive to your work (`rm -rf`, `git push --force`). Never silently
  auto-approved, keyed per danger *pattern* so "always allow git" cannot silently allow
  `git push --force`.
- **system-scope** = changes things outside this project (`brew install`, `sudo`, `npm -g`).

A command can be one, both, or neither. The sandbox, meanwhile, cannot ask anything — it can
only refuse a write at the OS layer, and it has nothing to say about `git push --force`, which
writes no files at all. **Deleting these would not simplify the security model; it would remove
the only place the user is told what is about to happen.**

### H4 — three places decide "this mode cannot write"

**Refuted. There is one decider, and the other two answer different questions.**

`isReadOnlyWorkMode` is defined once (`lib/work-mode.ts:19`) and called from exactly **one**
place in the whole codebase: `interceptor.ts:1597`, where it sets the sandbox profile. Verified
by grep — two call sites total, one of them the definition.

What looked like the other two deciders:

- `mode-tool-registry.ts` answers *"does this mode have `edit_file` in its toolset at all?"* —
  whether the tool exists, not whether a write lands.
- `wrap-command.ts` **consumes** the single decider's answer; it does not make one.

Defence in depth by design: a read-only mode both lacks the writing tools *and* runs commands
under a read-only sandbox profile, so a write is refused whether it is attempted through a tool
or through the shell. Two enforcement points, one decision.

---

## Finding 1 — `ask` rules are parsed, matched, logged, and never enforced

**Severity: user-visible half-feature. Not a security hole — it fails toward asking more, not
less.**

`.atlarix/permissions.json` accepts two lists. `deny` is enforced at
`tool-execute.ts:69-77` — a structured error the model sees. `ask` is compiled
(`ruleset.ts:89`), matched (`:129-131`), returned as a decision… and then:

```ts
if (decision?.kind === "ask") {
  // v1: mutating tools already prompt via the permission interceptor;
  // log the match so rule authors can see it firing.
  logger.log(`[ruleset] ask-rule matched for ${toolName}: ${decision.rule}`);
}
```

A user who writes `"ask": ["run_command(git push*)"]` gets a log line. The reasoning in the v1
scope note is sound for *mutating* tools — they already prompt — but it means the feature is
only ever a no-op or a duplicate, never an addition. The header names the real gap itself:
*"Forcing prompts on read-only tools is a documented follow-up."*

**Options, for a later release:**
1. **Enforce it** for tools that don't already prompt — the case the note describes.
2. **Reject it at parse time** with a clear error, so a rule author learns immediately instead
   of from a silent no-op.

Either is defensible; shipping a config key that does nothing is not. (1) is more work; (2) is
honest today and cheap.

## Finding 2 — the complexity is in one file, not in the module count

| module | lines | share |
| --- | ---: | ---: |
| `permissions/interceptor.ts` | 2,127 | **40%** |
| `sandbox/wrap-command.ts` | 462 | 9% |
| `permissions/handlers.ts` | 423 | 8% |
| `mode-tool-registry.ts` | 279 | 5% |
| `system-scope-commands.ts` | 237 | 4% |
| `dangerous-commands.ts` | 230 | 4% |
| `file-permission-scope.ts` | 228 | 4% |
| `hooks/file-hooks.ts` | 214 | 4% |
| `permissions/ruleset.ts` | 210 | 4% |
| `tools/permissions/schema.ts` | 199 | 4% |
| `resolve-toolset.ts` | 197 | 4% |
| `file-permissions-store.ts` | 180 | 3% |
| `file_permission_preflight.ts` | 175 | 3% |
| `tools/file-read-log.ts` | 136 | 3% |
| `command-permissions-store.ts` | 112 | 2% |
| `persist-safe.ts` | 69 | 1% |
| `security/env-secret-paths.ts` | 52 | 1% |
| **total** | **~5,530** | |

The single funnel is deliberate and correct — `.atlarix` rules, hooks, MCP consent, read-before-
edit scoping and the approval gate all apply uniformly to native *and* text-tool paths because
there is one place they can. But 2,127 lines is where a reviewer's attention should go, and it
is the one part of this surface that no module deletion improves.

**Recommendation: do not restructure it in the same release as anything else.** It is the file
every security property routes through, and the v14.25.0 batch already found eight defects in
this area that nobody was looking for.

---

## Checked and correct — leave alone

- **The unified grant list works as designed.** `writableRoots()` calls
  `listSandboxWritablePaths(workspaceId)` on **every** call rather than caching, which is what
  makes a revoke bite inside the same session. Covered by `granted-folders.test.ts` (14 cases,
  including that a grant does not widen to parents or siblings, and that a symlink inside a
  granted folder cannot escape).
- **`sandbox_path` rows sharing the `workspaceFilePermissions` table** looked like a coupling
  worth flagging, and on inspection is not: `resolveFilePermissionGate` matches on
  `row.scopeType` against `file`/`directory`/`extension`, so a `sandbox_path` row could never
  match even without the explicit `ne()` filter in `listWorkspaceFilePermissions`. The filter is
  belt-and-braces, not load-bearing.
- **The read path is ungated, and that is correct.** The interceptor has no `read_file` gate,
  and `wrap-command.ts:34` documents that even a read-only mode lets a command read anything.
  This matches the position `env-secret-paths.ts` states for reads and that v14.23.0 brought the
  write side into line with. **Do not "fix" this.**
- **`guard.ts`** — correct at what it does. Consider moving or renaming it purely so it stops
  reading as a permission module; no behaviour change.

## Suggested order for v14.27.0

1. Finding 1 — decide enforce-or-reject for `ask` rules. Small, self-contained, user-visible.
2. Finding 2 — only if it gets a release to itself.

Nothing else here needs work. The answer to "are we overcomplicating security" is **no, not by
duplication** — the layers are distinct and each earns its place. What the surface has instead
is one very large file and one config key that does not do what it says.
