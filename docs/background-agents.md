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

## V2 (session 15) — write-capable + approval gate + UI

- **Write mode** (`mode: "build"`): the runner flags its chat for in-process auto-approval (`setBackgroundAutoApprove(chatId)`), because no human is watching mid-turn. The interceptor's `permission-request` listener (the single choke point — it broadcasts to BrowserWindows for foreground turns) instead microtask-defers `executeBufferedPermission(chatId, opId)` for flagged chats. The microtask defer lets `waitForApproval` register its promise before the approval resolves (the re-entrancy hazard). `shouldAutoApprovePermissions` stays hard-`false` (locked) — this is a separate per-chat opt-in.
- **Isolation = the existing shadow-git snapshot.** The build interceptor captures a snapshot (keyed by the ledger turn id) before every write automatically. The runner reads that turn id from a new `ChatResponseEnd.snapshotTurnId` (set in `ensureTerminal` + the build epilogue) and records the changed files via `listSnapshotFiles`.
- **Approval gate:** `agents:background:resolve(sessionId, "keep"|"revert")` → `revert` calls `revertSnapshot` (created files are deleted), `keep` is a no-op. Surfaced in the Agents view.
- **Persistent status:** `chat_sessions.kind`/`status`/`status_error` (migration 0060). `hydrateBackgroundAgentsFromDb()` rebuilds the in-memory map on boot; a row still `running` at boot is marked `error: interrupted by restart`.
- **Per-agent cancel:** `agents:background:cancel(sessionId)` → `abortChatStream(chatId)` (the `chat:abort` path, in-process).
- **Agents view:** a RightPanel `agents` tab (`AgentsPanel.tsx`) polling `listBackgroundAgents()` — status, cancel, keep/revert, changed-file count.
- **Per-turn workModeOverride fix:** `buildLiveWorkMode` now honors `req.workModeOverride` over the live persisted `workModePreference` re-read (the re-read exists for mid-turn picker changes; an explicit per-turn override must win — without this a detached `build` turn ran read-only).

## Still deferred (conscious scope)

- **Concurrent-write isolation policy.** A write agent writes to the real working tree (shadow-git enables revert). If the user edits the same file in the foreground concurrently, last-write-wins; a worktree-per-agent model would remove the race but is a larger decision.
- **Revert after restart.** `snapshotTurnId`/`changedFiles` live on the in-memory record (lost on restart, though the shadow-git snapshot persists on disk) — the keep/revert gate is available during the session's lifetime, not across a restart.
- **Surfacing the Agents tab automatically** when an agent starts (today it's a tab the user opens), and a richer diff view.
