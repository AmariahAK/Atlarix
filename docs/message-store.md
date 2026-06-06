# Message store contract (v12 0.4)

One store of record, one transport buffer. This is the canonical description
of where chat messages live and when they move. Companion: marker
serialization lives in [marker-contracts.md](marker-contracts.md).

## The two layers

| Layer                          | Module / tables                                     | Id space                                                                                                              | Role                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session DB (authoritative)** | `chatSessions` + `sessionMessages` (sqlite/drizzle) | row UUIDs (`sessionMessages.id`); session UUID; `chatSessions.streamChatId` links the transport                       | The store of RECORD. Everything cross-turn — reload, resume, edits, native-history envelopes (`modelContent`), display snapshots — reads/writes here.                                                                                                                                           |
| **Stream transport buffer**    | `src/lib/chat/stream-transport.ts` (in-memory map)  | negative numeric `chatId` (transport handle); numeric message ids from a monotonic counter (`nextEphemeralMessageId`) | The per-transport TURN BUFFER + `{appId, title}` binding cache. Exists because a streaming turn mutates one `Message[]` in place and the renderer renders `chat:response:chunk` snapshots of it; `get-chat` mid-stream must see in-flight chunks the DB doesn't have yet. Wiped on app restart. |

**The bridge:** every persisted message carries its row UUID on the in-memory
message as `sessionRowId` —

- streamed user messages: set when the handler persists the prompt at
  dispatch (`persistWorkspaceSessionUserMessage` → returned row id),
- ask_user Q→A inserts: persist-then-insert threads the row id (0.4-C3),
- hydration: `sessionMessagesToUiMessages` keeps the DB id and the hydrate
  payload carries it into the buffer.

Renderer atoms keep NUMERIC keys (chatId + message id) — `sessionRowId` rides
along and never replaces the display id.

## Persistence timing

| Event                | What persists                                                                                                                                                                                                                                                                                        | Where                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| User sends a prompt  | user message row (content + modelContent + attachments)                                                                                                                                                                                                                                              | main, during dispatch (`chat_stream_handlers` → `persistWorkspaceSessionUserMessage`) |
| Turn streams         | NOTHING — chunks/native rewrites mutate the buffer only                                                                                                                                                                                                                                              | in-memory                                                                             |
| `chat:response:end`  | assistant message row (+ `modelContent` B2 envelope, displaySnapshot extras)                                                                                                                                                                                                                         | RENDERER convention: `useStreamChat` onEnd → `messages:add` (async, not awaited)      |
| User aborts mid-turn | partial response appended to the buffer (`appendTransportMessage`); renderer persists it at its onEnd                                                                                                                                                                                                | main appends, renderer persists                                                       |
| ask_user answer      | Q→A user row persisted FIRST (best-effort), then inserted into the buffer with its row id                                                                                                                                                                                                            | main                                                                                  |
| Message edit         | `persistEditedSessionMessageById(sessionRowId, content)` — direct row update + chronological tail delete. The buffer's truncation is a display mirror only. A message with NO `sessionRowId` was never persisted → visible "Edit not saved to session history" warning + `persistedToSession:false`. | main                                                                                  |

There are NO mid-stream assistant DB writes (prompt-cache + crash-consistency
by design). The ordinal eph↔DB mapping (`computeSessionEditTarget`) was
DELETED in 0.4-C3 — direct row ids are the only edit path.

## Hydration (reload / session switch)

`sessions:get` → renderer maps rows to UI messages (fresh numeric display
ids, `sessionRowId` kept) → `chat:hydrate-ephemeral-messages` (channel name
is historical) → `hydrateStreamTransport` replaces the buffer wholesale →
`rebuildSessionMemoryFromMessages`. The buffer is then trusted as the turn's
seed history because it was just built from the DB and the DB is updated in
lockstep during turns.

## Invariants (eval-pinned)

- Buffer ↔ DB lockstep after every completed turn: the buffer's user +
  assistant contents match `sessions:get` rows (`stream-transport-contract`
  eval; `ephemeral-session-roundtrip` pins the full reload cycle).
- Every streamed/persisted message in the buffer carries `sessionRowId`
  (`session-edit-boundary` eval).
- The B2 native-history envelope rides `modelContent` row→buffer→dispatch
  byte-stable (`native-history` eval).
- `sessions:delete` prunes the buffer + per-chat stream maps
  (`session-delete-cleanup` eval).

## Known deferred items (recorded consciously at the 0.4 close)

- Typed compaction rows / structured `<task_complete>` — the string markers
  are load-bearing and work (see marker-contracts.md).
- Physical buffer deletion (a thin transport registry + DB-only reads) —
  would mainly buy the <1,500-line `chat_stream_handlers` goal; revisit with
  the 2.3 background-agents session model if needed.
