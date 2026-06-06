# String-marker contracts (v12 0.4-C1 inventory)

The chat pipeline carries several in-band markers. This is the canonical
inventory: what produces each, what parses it, and its escaping story. New
code MUST use the structured forms; the content-tag family below is the
renderer-display contract and stays string-based by design (already
JSON-structured where it matters).

> History: marker escaping has bitten before (the `__ask_user` envelope bug —
> v10.1; the `</atlarix` closer escape — v12 session 1). When touching a
> producer or parser, update this file.

## Structured tool-result contracts (objects, NOT strings)

| Marker | Producer(s) | Parser(s) | Notes |
|---|---|---|---|
| `{__permission_required: true, operation, preview}` | `file.ts` (write_file/write_multiple_files), `edit.ts`, `shell.ts` (run_command, run_tests), `memory.ts` (revert), `workspace.ts` (limits) | `permissions/interceptor.ts` (`isPermissionRequest`/`parsePermissionRequest`), `registry.ts` (escapes the `{success, result}` envelope), `guard.ts` (pass-through) | Schema: `permissions/schema.ts`. The legacy `"__PERMISSION_REQUIRED__"` TEXT format was deleted in 0.4-C1 (its last main-process producer, `run_tests`, now emits the structured form; the legacy parser misparsed it anyway). The renderer-side legacy chat-only page (`atlarix-chat.tsx` → `lib/providers/*`) keeps its own private string variant that never reaches the interceptor. |
| `{__ask_user: true, question(s), …}` | `workspace.ts` ask_user tool | `registry.ts` (envelope escape), `chat_stream_handlers.ts` (`resolveAskUserToolResult` → end-turn) | The v10.1 bug: nested inside the `{success, result}` envelope, every interceptor missed it. Now escapes the envelope at the registry (same contract as `__permission_required`). |

## Loop-control text markers (load-bearing — convert in 0.4-C2/C3)

| Marker | Producer | Parser | Notes |
|---|---|---|---|
| `<task_complete>` | model output (prompted) | `responseHasTaskCompleteTag` (completion-detector.ts) — engine break gate; `stripTaskCompleteTags` (thinking_tags.ts) before display/persist | Since 0.3 the break is additionally gated on post-write diagnostics. Structured finish-signal conversion lands with the C2/C3 store work. |
| `[COMPACTION MARKER]` prefix (`COMPACTION_SUMMARY_PREFIX` … `[END COMPACTION]`) | `context/compaction.ts` (summary message) | `isCompactionSummaryMessage` / `sliceFromLastCompactionSummary` — dispatch slices from the LAST summary | Becomes a typed `kind:"compaction"` session-message row in C2. |

## Renderer-display content tags (string contract by design — survive reload)

Producers in `ipc/utils/stream_chunk_tags.ts`; parsers in
`ipc/utils/atlarix_tag_parser.ts` (8 extractors); escaping in
`ipc/utils/escape_atlarix_tags.ts` (full-width `＜` replacement applied to
reasoning blocks + tool content so model output can mention the tags safely —
covers `</atlarix` closers since v12 session 1).

| Tag | Purpose |
|---|---|
| `<atlarix-tool-call tool=>` / `<atlarix-tool-result tool=>` / `<atlarix-mcp-tool-call server= tool=>` | inline tool timeline (text-tool fallback path) |
| `<atlarix-write path=>` / `<atlarix-delete>` / `<atlarix-rename>` / search-replace / execute-sql / command variants | file-op display + apply parsing |
| `<atlarix-sources>{json}</atlarix-sources>` | reload-stable web citations (v10.1) |
| `<atlarix-chat-summary>` | session titling |
| `<!-- atlarix-questions:{json} -->` | reload-durable pending ask_user questions (`lib/chat/ask-user-artifacts.ts` — HTML comment shields the JSON from tag parsers) |
| `<!-- atlarix-plan-artifact:id -->` | inline plan-card anchor (`lib/plans/plan-artifacts.ts`; `ensurePlanMarkersInAssistantContent` backstops a missing marker) |

## Native-history envelope (structured, persisted)

`{v:1, kind:"native-history", messages, producedBy}` on the assistant
message's `modelContent` (`lib/ai/native-history.ts`) — v12 0.2 (B2).
Versioned JSON; old sessions without it fall back to the string path.
Transient round inputs (loop corrections, 0.3 diagnostics feedback) are
intentionally NOT mirrored into it.
