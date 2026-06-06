# The portable `.atlarix/` workspace contract

Everything that makes an Atlarix workspace _yours_ lives in a committable
`.atlarix/` directory. `git clone` → open in Atlarix → the same AI workspace:
the same rules, memory, agents, hooks, permissions, and plans. This is the
foundation Cursor lacks — your AI configuration travels with the repo.

> Companion docs: [message-store.md](message-store.md) (chat persistence),
> [marker-contracts.md](marker-contracts.md) (stream markers).

## Committable (travels with the repo — the contract)

| Path                               | What it is                                                                                                                                                                   | Read by                                                              | Written by         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------ |
| `.atlarix/atlarix.md`              | **Project rules** — instructions every turn follows (conventions, tech constraints). Loaded into the system prompt when non-empty.                                           | `buildSystemPromptWithProjectInstructions` (prompts)                 | user / `edit_file` |
| `.atlarix/memory.md`               | **Model's project memory** — durable facts (architecture, layout). Read on demand to skip re-scans; never force-injected.                                                    | `read_file` (hinted), project-memory                                 | agent / user       |
| `.atlarix/agents/<name>.md`        | **User-defined agents** (Tier 7A) — frontmatter `{description, mode, model?, tools?}` + a system-prompt body. Selected in the work-mode picker.                              | `listUserAgents` / `loadUserAgent` (`src/lib/agents/user-agents.ts`) | user               |
| `.atlarix/agents/<mode>-mode.md`   | **Mode-skill overrides** — `ask-mode.md`/`build-mode.md`/… REPLACE a built-in mode's guidance (distinct from user agents; the user-agent loader skips these reserved names). | `loadSkill` (skill-loader)                                           | user               |
| `.atlarix/permissions.json`        | **Permission ruleset** (Tier 2.2) — `{deny, ask}` glob patterns (`run_command(rm *)`, `write_file(.env*)`). Enforced at the tool funnel.                                     | `loadWorkspaceRuleset` (`permissions/ruleset.ts`)                    | user               |
| `.atlarix/hooks/hooks.json`        | **Blocking hooks** (Tier 7B) — `pre_tool_use` / `post_tool_use` / `stop`, shell + globs, no AI. A red `pre_tool_use` denies a tool; a red `stop` blocks `<task_complete>`.   | `file-hooks.ts`                                                      | user               |
| `.atlarix/skills/`                 | Workspace-scoped skill files (priority-injected for Workforce).                                                                                                              | priority-skill-loader                                                | user               |
| `.atlarix/reference-projects.json` | External reference-repo registry for cross-project examples.                                                                                                                 | reference-manager                                                    | user / import      |
| `.atlarix/.atlarixignore`          | `.gitignore`-style exclusions for the file watcher / scans.                                                                                                                  | atlarix-ignore                                                       | user (bootstrap)   |

## Generated caches (gitignore-able — rebuilt on demand)

| Path                      | What                                                                | Notes                                                 |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| `.atlarix/symbols.json`   | ctags symbol index (BM25 search, Blueprint).                        | rebuilt incrementally from file mtimes                |
| `.atlarix/blueprint.json` | committed Blueprint snapshot (`commit_blueprint`, Workforce).       | the `blueprints/` cache is per-machine, not this file |
| `.atlarix/plans/`         | session plan artifacts + `plans/archive/`.                          | plan ledger serialization                             |
| `.atlarix/snapshots/`     | legacy per-turn revert snapshots (mostly superseded by shadow-git). | machine-local                                         |
| `.atlarix/training_data/` | reserved for the "learning workspace" research idea.                | not yet wired                                         |

A reasonable `.gitignore`: commit `atlarix.md`, `memory.md`, `agents/`,
`permissions.json`, `hooks/`, `skills/`, `reference-projects.json`,
`.atlarixignore`; ignore `symbols.json`, `blueprints/`, `snapshots/`,
`training_data/`.

## User-defined agent format (7A)

```markdown
---
description: Cautious reviewer
mode: ask # base work-mode profile (default build)
model: anthropic/claude-opus-4-8 # optional per-turn model override
tools: [read_file, search, get_blueprint] # optional allowlist subset
---

You are a meticulous reviewer. Find correctness bugs, not style nits.
Never propose writes; report findings and stop.
```

The agent is an `AgentProfile` assembled from disk on top of its base mode:
its body is prepended into the system header, `tools:` intersects the mode's
offered set (composing with the capability trim), and `model:` becomes the
turn's model override. Select it in the work-mode picker ("Workspace agents"
group). Reserved `<mode>-mode.md` names are mode-skill overrides, not agents.

## Follow-ups (not yet in the contract)

- `~/.atlarix/` global layer (permissions/hooks/agents shared across
  workspaces; workspace rules shadow global).
- A `.atlarix/agents/` editor UI (today: hand-written markdown).
