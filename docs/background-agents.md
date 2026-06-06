# Background agents (v12 Tier 2.3)

A **background agent** is a chat turn that runs detached — no foreground
renderer attached — into its own workspace session, surfacing the result as a
session the user opens afterwards. "Beside / by itself" without a second engine.

## Design spike — is it clean?

Verified against the streaming path. The mechanics already support it:

- **Concurrent streams are keyed by `chatId`** (`activeStreams: Map<number, AbortController>`). Nothing globally locks a single stream — a detached turn and a foreground turn coexist as long as their chat ids differ.
- **The IPC sink is `safeSend(event.sender, …)`**, which no-ops on a destroyed/absent sender. A synthetic `{isDestroyed:()=>false, isCrashed:()=>false, send}` sender is the entire contract the handler needs (the eval harness already uses exactly this).
- **The engine binds its own workspace + persists the USER message** at dispatch (`persistWorkspaceSessionUserMessage`), so a background turn needs only a session id + app id.

Two real prerequisites the spike surfaced (both fixed in this session):

1. **One unwrapped `event.sender.send`** (the compass error path) would throw on a synthetic sender — wrapped in `safeSend`.
2. **The assistant message is persisted by the RENDERER** on `chat:response:end` (it calls `messages:add`). A detached turn has no renderer, so the runner persists the assistant message itself via the new main-side `addSessionMessageDirect` (the `messages:add` handler now delegates to it too).

Verdict: clean. V1 implemented.

## V1 (this session) — read-only

`src/lib/agents/background-agent.ts`:

- `startBackgroundAgent({appId, prompt, title, startedAt})`:
  1. `createBackgroundWorkspaceSession(appId, title)` → a fresh session + bound transport (no empty-session reuse — a background agent always gets its own session).
  2. Dispatch the captured `chat:stream` handler (`getChatStreamHandler()`) with a synthetic recording sender and `workModeOverride: "ask"`.
  3. On completion, persist the assistant message (captured from the streamed `chat:response:chunk` buffer + the `assistantModelContent` envelope) via `addSessionMessageDirect`.
- Status lives in an in-memory `Map<sessionId, record>` (`running`/`done`/`error`), surfaced by `agents:background:list`. It does not survive a restart — but a _finished_ agent is just its session, which persists in the DB; the user opens it like any other session.
- IPC: `agents:background:start` (fire-and-forget) + `agents:background:list` (poll).

### Why read-only for V1

`ask`-mode gives the exploration tool surface (read/search/blueprint) and **no writes, no `run_command`**. A detached turn that can't be watched must not mutate the workspace. This sidesteps the worktree-vs-shadow-git isolation question entirely — a write-capable background agent needs that decision made first (see below).

## Deferred (conscious scope)

- **Write-capable background agents** need isolation (git worktree per agent, or shadow-git branch) so a detached writer can't race the foreground turn on the working tree. That isolation model is its own decision — not made here.
- **A dedicated "agents" renderer view.** V1 ships the IPC (`listBackgroundAgents`) and the data; a finished agent already appears in the normal session list (titled `🤖 …`). A running/finished indicator panel over the session list is the natural next increment — the data is there to drive it.
- **Persistent status across restart** (a `status` column on `chat_sessions`) — V1 keeps status in memory; the session itself is the durable record.
- **Cancellation of a running background agent** — `chat:cancel` works by `chatId`; wiring a per-agent cancel button is a UI increment.
