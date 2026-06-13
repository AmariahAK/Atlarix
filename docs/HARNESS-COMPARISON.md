# Atlarix Harness Comparison

**Atlarix vs Claude Code · opencode · Cursor · Antigravity · Codex**
_Last updated: 2026-06-13 · against Atlarix v13.x working tree_

> **Scope.** This compares Atlarix **as an agent harness** — the loop, tools, context engine,
> retrieval, provider abstraction, sandboxing, sub-agents, verification. It deliberately
> **excludes IDE-surface features** (autocomplete/Tab, inline prediction, editor ergonomics):
> Atlarix is a harness, not an IDE, so comparing tab-completion would be comparing the wrong thing.
> Verdicts are from Atlarix's vantage point: **▲ superior / leading · ◆ at parity · ▼ lacking**.

---

## TL;DR

Atlarix is a **genuinely competitive frontier harness** whose architecture is, on several axes,
ahead of the open-source field (opencode) and at parity with the proprietary leaders (Claude Code,
Codex) on the fundamentals. Its **distinctive wedge is open-weight models**: it is the only harness
here that is *designed and tuned* for DeepSeek / Qwen / Kimi / MiniMax as first-class citizens
rather than as an afterthought behind a proprietary flagship.

Where it trails is **reach, not mechanics**: no cloud/async agents, no public agent SDK, sub-agents
are read-only only, and there is no open-model eval/quality loop to *prove* the open-weight claim.
Those are the things to invest in next — see [Invest-next](#invest-next-backlog).

**Can Atlarix claim "we stand for open-weight models, now & forever"?** Architecturally, yes — the
foundations (native tool history, open-weight-tuned context heuristics, broad direct-provider
coverage, local-first BYOK) are real and hard to copy as a *posture*. But the title has to be earned
continuously with an eval loop and model-coverage cadence, not declared once. See [Thesis](#thesis-the-frontier-open-weight-harness--now--forever).

---

## Capability matrix

Rating per harness, per dimension: **● strong · ◐ partial · ○ absent/weak**. Final column is Atlarix's
standing **vs the field**.

| Dimension | Atlarix | Claude Code | opencode | Cursor | Antigravity | Codex | Atlarix vs field |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Core agent loop (native tool-calling, streaming) | ● | ● | ● | ● | ● | ● | ◆ |
| **Open-weight provider support (direct + tuned)** | ● | ○ | ◐ | ◐ | ◐ | ○ | ▲ |
| Provider/model abstraction breadth | ● | ◐ | ● | ◐ | ◐ | ◐ | ◆ |
| Code retrieval (structural Blueprint vs embeddings) | ● | ◐ | ◐ | ● | ● | ◐ | ▲ |
| Context mgmt (compaction, per-step budget, caching) | ● | ● | ● | ● | ● | ● | ◆ |
| Provider-agnostic prompt caching | ● | ◐ | ● | ◐ | ◐ | ◐ | ▲ |
| Sub-agents / parallel tasks | ◐ | ◐ | ● | ◐ | ● | ◐ | ▼ |
| Background / async execution | ◐ | ◐ | ● | ● | ● | ● | ▼ |
| Cloud / managed agents | ○ | ◐ | ◐ | ● | ● | ● | ▼ |
| Sandboxing (OS-enforced) | ● | ● | ◐ | ● | ◐ | ● | ◆ |
| Permissions model | ● | ● | ● | ◐ | ◐ | ● | ◆ |
| MCP support | ● | ● | ● | ● | ● | ● | ◆ |
| Verification (runs project's real checks) | ● | ● | ◐ | ◐ | ● | ● | ◆ |
| Browser automation (in-harness) | ● | ○ | ○ | ◐ | ● | ○ | ▲ |
| Real terminal (persistent PTY) | ● | ◐ | ◐ | ● | ● | ◐ | ◆ |
| Extensibility (skills / hooks / plugins) | ◐ | ● | ● | ● | ● | ◐ | ▼ |
| Public agent SDK (build on the harness) | ○ | ◐ | ◐ | ● | ● | ● | ▼ |
| Testability / eval harness | ● | ○ | ● | ○ | ○ | ◐ | ▲ |
| Local-first / offline-capable | ● | ◐ | ● | ○ | ◐ | ◐ | ▲ |

_(Ratings for closed systems — Claude Code, Cursor, Antigravity, Codex — are inferred from public
docs and the local `atlarix-references/claude-code` extract; treat them as directional.)_

---

## Per-dimension analysis

### 1. Core agent loop — ◆ parity
Atlarix's `runAgentTurn()` is a unified, profile-driven loop on the Vercel AI SDK (ai@6) with native
tool-call parsing, streaming, mid-loop compaction, sub-agent result injection via `prepareStep`, and
explicit stop sentinels (`task_complete`, `ask_user`, loop-repetition, limit). This is the same shape
as Codex's "unrolled" loop and opencode's `SessionRunner`. opencode is arguably ahead on *durability*
(its turn boundaries are crash-recoverable, replayable epochs); Atlarix's loop is in-process and
session-lifetime. Mechanics are at parity; durability is the one place opencode leads.

### 2. Open-weight provider support — ▲ leading (the wedge)
This is Atlarix's defining advantage. It ships **direct, first-class** providers for DeepSeek, Qwen
(Alibaba DashScope), MiniMax and Kimi (Moonshot) — plus OpenRouter, Together, Groq, Cerebras, NVIDIA
NIM, Hugging Face, Ollama and LM Studio. Crucially, the harness is *tuned* for these models, not just
wired to them:
- **Native tool history** — tool calls/results ride as provider-native blocks, not text-XML.
  Weak/open models follow tool protocols far more reliably this way, and it preserves cache hits.
- **Open-weight context heuristics** — `resolve-model-context-limit.ts` already carries family
  defaults (DeepSeek/Qwen/Kimi → 128K, MiniMax → 1M) so windows are right even on catalog miss.
- **Thinking-mode awareness** for deepseek-reasoner, Qwen3 and MiniMax M2.x.

No competitor is *positioned* here. Claude Code is Anthropic-first; Codex is GPT-first; Cursor and
Antigravity optimize their own proprietary/flagship models (Composer, Gemini 3) and treat open
weights as a BYOK option. opencode has the broadest neutral provider layer (models.dev) and is the
closest, but it is provider-*agnostic*, not open-weight-*championing*. **Atlarix is the only harness
whose identity is the open-weight frontier.**

### 3. Provider/model abstraction breadth — ◆ parity (with opencode)
Atlarix and opencode are the two broadest. opencode's models.dev catalog is the gold standard for
metadata (cost tiers, modalities, reasoning flags). Atlarix mirrors much of this (it already falls
back to models.dev) and adds native per-provider fetchers with tool-capability filtering. Parity,
with opencode slightly ahead on catalog richness and Atlarix ahead on direct open-weight endpoints.

### 4. Code retrieval — ▲ leading (by a different bet)
Atlarix's **Blueprint** is a permanent ctags + ast-grep + BM25 structural index that reranks grep and
honors dynamic calls — **no embeddings, ever**. Cursor and Antigravity bet the other way (Cursor chunks
+ embeds into Turbopuffer for semantic search). The embedding approach wins on fuzzy natural-language
recall ("where does token refresh happen"); Blueprint wins on **precision, freshness, privacy and
zero-cost local operation** (no embedding bill, no vector DB, file-watcher-warm). For an open-weight,
local-first harness this is the *right* bet and a real differentiator — but it is a genuine trade-off,
not a strict win. The honest gap: pure semantic recall.

### 5. Context management — ◆ parity
Per-step token metering, 75% compaction threshold with summarization, protected exchanges, mid-loop
compaction. Comparable to Claude Code and Codex. opencode's context-epoch model (immutable baseline
per epoch, durable across restarts) is the most sophisticated design in the field; Atlarix's is
solid and effective but in-memory. Parity on effectiveness, opencode ahead on architecture.

### 6. Provider-agnostic prompt caching — ▲ leading
Atlarix places cache markers correctly across **every** provider shape: Anthropic message-level
(1h TTL on header), OpenAI `promptCacheKey` + 24h retention, OpenRouter sticky `x-session-id`, with
per-step breakpoint advancement. This breadth (matching opencode's per-request re-transform, ahead of
most) directly lowers the cost of running long open-weight sessions. A quiet but real strength.

### 7. Sub-agents / parallel tasks — ▼ lacking
Atlarix has one `task` tool: up to 5 concurrent **read-only** scouts with live thought streaming and
auto-injection of results. This is clean and safe — but **read-only and depth-1 only**. opencode
(background jobs with promotion/cancel) and especially **Antigravity** (parallel *writing* sub-agents
coordinated by a Manager surface, A2A protocol) go materially further: multiple agents doing real work
in parallel. This is Atlarix's biggest mechanical gap.

### 8. Background / async execution — ▼ lacking
Atlarix has background `run_command` (mid-turn injection, no polling) — good, but scoped to shell
commands. The field has full **background agents** (Cursor, Antigravity, Codex cloud) that run whole
tasks asynchronously. Atlarix is single-session, foreground-anchored.

### 9. Cloud / managed agents — ▼ absent
Cursor (Cloud Agents/VMs), Antigravity (Managed Agents API, persistent Linux envs), and Codex (cloud
containers, two-phase setup/agent) all offer server-side execution. Atlarix is **local-only**. This is
a deliberate local-first posture (and a privacy selling point for open weights), but it is a reach gap.

### 10. Sandboxing — ◆ parity
OS-native write-confining sandbox (macOS Seatbelt, Linux bwrap, Windows AppContainer) with graceful
fallback, network on. Directly comparable to Codex's `workspace-write` OS sandbox and Claude Code's
sandbox. Ahead of opencode (which relies on permission rules, not an OS sandbox). Strong.

### 11. Permissions — ◆ parity
Portable `.atlarix/permissions.json` (workspace) + global layer, deny/ask patterns, single execution
funnel, dangerous-command hard floor. Conceptually equal to Codex's sandbox+approval split and
opencode's wildcard rules. Solid and clean.

### 12. MCP — ◆ parity
Per-workspace MCP with interactive OAuth (no mid-turn browser hijack), `list_available_mcps` +
`mcp_call`. Everyone has MCP now; Atlarix's is well-built and at parity.

### 13. Verification — ◆ parity (a strength)
Build/Debug modes run the **project's own** checks/tests via `run_command` (tsc, eslint, pytest,
ruff) and gate `task_complete` on them — after deliberately removing LSP. This "use the repo's real
tooling" approach matches Codex/Antigravity and is more portable than an LSP dependency. Quietly strong.

### 14. Browser automation — ▲ leading
In-app Electron WebContentsView with read/click/fill tools and an untrusted-content envelope. Only
Antigravity has a comparable first-class browser agent; Claude Code, opencode and Codex have none
built in. A real differentiator for research/debugging flows.

### 15. Real terminal — ◆ parity
Persistent xterm.js + node-pty tabs that survive restarts, separate from sandboxed agent commands.
On par with Cursor/Antigravity's integrated terminals; ahead of CLI-only harnesses on persistence.

### 16. Extensibility — ▼ lacking
Atlarix has skills (mode + repo `.atlarix/skills/`) and MCP — good. But it lacks Claude Code's **hook
system** (PreToolUse/PostToolUse/Stop/SessionStart) and the **plugin marketplace** ecosystem that
Claude Code, opencode, Cursor and Antigravity all cultivate. Third parties can't deeply customize the
loop. A genuine gap if a community is the goal.

### 17. Public agent SDK — ▼ absent
Cursor, Antigravity and Codex all expose an SDK/CLI to build agents *on* their harness. Atlarix has no
public build-on-us surface. For "frontier harness" ambitions this is the largest strategic gap.

### 18. Testability / eval harness — ▲ leading
The `tests/agent-evals` harness drives the **real** chat-stream handler against a fake-LLM server with
real temp sqlite (1173+ unit tests, 55+ evals). This is rare — opencode has strong testing; the
proprietary harnesses publish none. A real engineering-quality edge. The missing piece is
**open-model quality evals** (see thesis).

### 19. Local-first / offline — ▲ leading
Fully local app, BYOK any model, Ollama/LM Studio for fully-offline open weights, local Blueprint
index (no embedding service). Only opencode is comparably local-capable; the cloud-tilted harnesses
(Cursor especially) are not. This is the natural home of the open-weight thesis.

---

## Where Atlarix stands

**Superior / leading (▲):** open-weight provider support & tuning · structural retrieval (Blueprint) ·
provider-agnostic prompt caching · in-harness browser automation · eval/test harness · local-first.

**At parity (◆):** core loop · provider breadth · context management · sandboxing · permissions · MCP ·
verification · terminal.

**Lacking (▼):** parallel *writing* sub-agents · background/async agents · cloud/managed execution ·
deep extensibility (hooks/plugins) · public agent SDK.

---

## Improve / Refine / Remove

**Improve (close the ▼ gaps that matter):**
- **Writing sub-agents.** Lift `task` beyond read-only — allow a sub-agent to make scoped writes in an
  isolated worktree/branch with results merged under approval. This is the single highest-leverage gap.
- **Background agents.** Generalize the existing background-command seam into background *tasks* (a whole
  agent turn that reports back), reusing the `prepareStep` injection plumbing already built.
- **Hooks.** A minimal PreToolUse/PostToolUse/Stop hook surface would unlock community extension without
  the weight of a full plugin marketplace.

**Refine (sharpen existing strengths):**
- **Open-weight model catalog cadence.** Model lists are sourced dynamically (live provider `/models`
  → auto-updating models.dev catalog), so no list is hardcoded — the only maintenance is keeping the
  models.dev id mappings correct (`qwen→alibaba`, `moonshot→moonshotai`) as vendors add endpoints.
- **Blueprint + semantic recall.** Keep Blueprint as the default, but consider an *optional*, fully-local
  embedding lane for fuzzy NL recall to neutralize the one place Cursor/Antigravity lead — without
  betraying the no-cloud-embeddings stance.
- **Context durability.** Borrow opencode's epoch idea to make compaction/checkpoints survive restarts
  (the deferred `snapshotTurnId` persistence item).

**Remove / simplify (continue the v13 discipline):**
- The already-deferred cleanups: drop `maybeTruncateToDisk` for plain offset-paging, split the 7.4K-line
  `chat_stream_handlers.ts`, drop the `ToolCategory`/cost field and the capability-trim stage at 22 tools.
- Finish the **V3 provider migration** for the elastic/cohere adapters (currently compat-wrapped with a
  console warning) — niche providers carrying special-case code against the open-weight core.

---

## Thesis: the frontier open-weight harness — now & forever?

The repo already adopted **"the open-weight frontier harness"** as its canonical identity (the
2026-06-13 alignment sprint). The architecture earns it:

1. **Native tool history** makes weak/open models behave like strong ones on tool protocols — the
   single most important enabler for open-weight agentic work, and most harnesses still pass tools as
   text.
2. **Open-weight-tuned context heuristics** mean DeepSeek/Qwen/Kimi/MiniMax "just work" on window
   sizing where a generic harness mis-sizes them.
3. **Direct provider coverage** (not only via OpenRouter) plus Ollama/LM Studio gives the full ladder
   from frontier-API open weights down to fully-offline local.
4. **Local-first + structural (non-embedding) retrieval** means the whole stack can run with no
   proprietary cloud dependency — the only honest home for an open-weight movement.

That is a defensible *posture* no competitor currently occupies: Claude Code and Codex are
flagship-locked; Cursor and Antigravity optimize their own models and lean cloud; opencode is neutral
but not a *champion*.

**The honest caveats** — the title is earned continuously, not declared:
- **No open-model quality loop.** The eval harness tests the *harness*, not whether DeepSeek-V4 or
  Kimi-K2 actually completes tasks well *through* Atlarix. Without an open-model eval suite, "frontier
  for open weights" is an architectural claim, not a measured one. **This is the #1 thing to build.**
- **Model-specific tool-format quirks.** Open weights vary in tool-call fidelity; a per-model
  conformance/repair layer (and tracking which models pass) would harden the claim.
- **Reach gaps** (sub-agents/background/cloud/SDK) are where the proprietary field is pulling ahead;
  none contradict the open-weight thesis, but they determine whether the harness is *also* frontier on
  capability, not just on principle.

**Verdict:** Atlarix can legitimately *stand for* open-weight models today on architecture, and is the
best-positioned harness in this set to *own* that title — **if** it adds an open-model eval/quality
loop to prove it and keeps the provider catalog current. "Now": yes, credibly. "Forever": only with the
eval loop and cadence that turn the posture into a continuously-verified promise.

---

## Invest-next backlog

Distilled into `docs/TODO.md` under the harness-parity section. Priority = impact on the open-weight
frontier claim × gap size.

| Pri | Item | Why |
|:--:|---|---|
| **P0** | Open-model eval suite (real tasks through Atlarix on DeepSeek/Qwen/Kimi/MiniMax) | Turns the "frontier open-weight" claim from architectural to measured. The keystone. |
| **P0** | Writing sub-agents (scoped, worktree-isolated, approval-merged) | Biggest mechanical gap vs opencode/Antigravity; unlocks real parallel work. |
| **P1** | Background *task* agents (generalize the background-command seam) | Async capability without going cloud; reuses existing plumbing. |
| ~~P1~~ ✅ | ~~Auto-updating open-weight model catalog~~ (done) | Model lists are dynamic (live `/models` → models.dev); no hardcoded lists remain. |
| **P1** | Minimal hook surface (PreToolUse/PostToolUse/Stop) | Community extensibility without a full marketplace. |
| **P2** | Optional fully-local semantic-recall lane alongside Blueprint | Neutralizes the one retrieval axis where Cursor/Antigravity lead. |
| **P2** | Persist context checkpoints across restarts (`snapshotTurnId`) | Borrow opencode's durability; finish a deferred item. |
| **P2** | Per-model tool-call conformance/repair + pass-tracking | Hardens open-weight reliability; feeds the eval suite. |
| **P3** | Public "build-on-Atlarix" agent SDK | Strategic, large; only if a third-party ecosystem becomes a goal. |
| **P3** | Finish elastic/cohere V3 adapter migration; continue v13 simplification cuts | Remove special-case weight around the open-weight core. |
