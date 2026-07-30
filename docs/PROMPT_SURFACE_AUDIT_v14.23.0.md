# Prompt-surface audit — v14.23.0

**Report only.** No code changed for this document. It closes the "report-only audit sweep"
carried from v14.22.0: the three `builtin-agents.ts` prompts vs `src/skills/subagents/*.md`,
`context_compaction_prompt.ts` against opencode's equivalent, and the 16 `<system-reminder>`
injection sites.

Measurements taken from the working tree at v14.23.0; opencode figures from
`atlarix-references/opencode`.

---

## 1. Sub-agent role prompts: two definitions of the same role, and the recommended path gets the thinner one

There are two independent sources for a sub-agent's system prompt, and which one applies depends
only on whether the caller named an agent type.

| Path | Source | Size |
|---|---|---|
| `task({ subagent_type: "explorer" })` | `EXPLORER_PROMPT` (`builtin-agents.ts`) | **338 chars** |
| `task({ subagent_type: "architect" })` | `ARCHITECT_PROMPT` | **200 chars** |
| `task({ subagent_type: "implementer" })` | `IMPLEMENTER_PROMPT` | **108 chars** |
| `task({ description, … })` — no type | `skills/subagents/subagent.md` | 27 lines (~1.1 KB) |
| `task({ write: true })` — no type | `skills/subagents/subagent-writer.md` | 44 lines (~1.9 KB) |

Resolution order is `loadUserAgent()` → workspace `.atlarix/agents/<name>.md`, else
`BUILTIN_AGENTS[name]` (`user-agents.ts:187-204`); `run-subagent.ts:286-296` falls back to the skill
markdown **only when no agent type resolved**. So the two sources are mutually exclusive — this is
NOT duplicated context.

**The finding is inconsistency, pointed the wrong way.** The opening paragraphs are near-verbatim
between `EXPLORER_PROMPT` and `subagent.md` ("You are a focused read-only sub-agent spawned to
answer ONE scoped question or map ONE area. Your final message is returned to the parent agent as
data — write it for an agent, not a human."), so they will drift. And the mode prompts actively
steer callers to the *named* form — Plan mode says "fan out `task({subagent_type:"explorer"})`",
Build mode names all three — which is the path receiving **338 chars instead of ~1.1 KB**. The
guidance a scout actually needs (scope discipline, evidence/citation format, no-expansion rule)
is fuller in the markdown that the recommended call path never loads.

`IMPLEMENTER_PROMPT` at 108 chars is the sharpest case: `subagent-writer.md` spends 44 lines
explaining that a writer's edits become **proposals the main agent reviews** rather than disk
writes — the single most surprising fact about writer sub-agents, and the named `implementer` never
reads it.

**Suggested direction (not done here):** make `BUILTIN_AGENTS[*].systemPrompt` load the same skill
markdown the generic path uses, and keep the constants only for the genuinely role-specific delta.
One definition per role. Wants its own change — it alters what every named sub-agent is told.

---

## 2. `context_compaction_prompt.ts` vs opencode's `compaction.txt`

| | Bytes |
|---|---|
| Atlarix `src/prompts/context_compaction_prompt.ts` | **2,298** |
| opencode `agent/prompt/compaction.txt` | **823** |

~2.8×. Not a defect on its own: the file is a whole TS module (imports, export, doc comment), so the
prompt text itself is smaller than 2,298 bytes, and compaction quality directly determines what
survives a long session — the wrong economy to chase. Recorded as measured, with no change
recommended. If it is ever revisited, compare *prompt text* to prompt text, not file to file.

For calibration, opencode's plan-mode prompt is **4,547 bytes** and its explore prompt **871** — so
its own surface is not uniformly terse, and "opencode is 823 bytes" is not by itself an argument.

---

## 3. `<system-reminder>` injection sites

**22 sites across 14 files** (excluding tests) — the carried note said 16, so the surface grew by
6 since it was written.

`src/lib/streaming/system-reminder.ts` (the shared wrapper), `prompts/system_prompt.ts`,
`ipc/handlers/chat_stream/turn-runner/{prompt-bundle,simple-stream-text}.ts`,
`lib/agent/run-agent-turn.ts`, `lib/agents/run-subagent.ts`, `lib/chat/stream-transport.ts`,
`lib/streaming/{continuation-handler,untrusted-data}.ts`, `lib/context/dropped-history-notice.ts`,
`lib/chat/attachment-tag-escape.ts`, `lib/tools/browser.ts`, `components/SimpleInlineChat.tsx`,
`ipc/ipc_types.ts`.

No contradiction found between sites, and all route through the shared wrapper rather than
hand-writing the tag. Two observations worth keeping:

- The convention "`<system-reminder>` blocks are injected by the harness, not the user" is stated in
  the main system prompt AND restated at `run-subagent.ts:304-305`, because sub-agents don't receive
  the main prompt. That restatement is correct, not redundant.
- `components/SimpleInlineChat.tsx` is the one *renderer* site. Worth confirming it wraps rather
  than displays; not investigated here.

---

## Net

One finding worth acting on (§1 — the named-agent path is under-prompted, and two copies of the same
role text will drift), one measurement with no action (§2), and one count correction (§3: 16 → 22).
Nothing here is a live bug.
