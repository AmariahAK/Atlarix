/**
 * File shapes carried by the versioned-context path.
 *
 * WHAT USED TO BE HERE
 * --------------------
 * `extractCodebase` / `extractCodebaseCached` — a whole-repo reader that walked
 * the workspace, filtered by an allowed-extension list, capped file sizes, and
 * formatted every file into one string for injection into the prompt. Retrieval
 * moved to on-demand `grep` / `glob` / `read_file` long ago (see the PASS1 note
 * at `chat_stream_handlers.ts`: "no proactive codebase-context injection"), and
 * the two remaining callers were both unreachable:
 *
 * - `context_paths_handlers` was driven by `ContextFilesPicker`, which renders
 *   only behind a `showContextFilesPicker` prop that defaults to false and was
 *   never passed by the single `<ChatInputControls>` call site.
 * - `get-chat-logs` had a preload channel and an `ipc_client` method but no UI
 *   consumer at all.
 *
 * Both are gone, and the extractor went with them — along with `isExcludedDir`,
 * the last consumer of the hand-maintained exclusion list that
 * `workspace-file-list.ts` replaced.
 *
 * These interfaces stay because `versioned_codebase_context.ts` and
 * `simple-stream-text.ts` are live and type against them.
 */

export interface BaseFile {
  path: string;
  focused?: boolean;
  force?: boolean;
}

export interface CodebaseFile extends BaseFile {
  content: string;
}

export interface CodebaseFileReference extends BaseFile {
  fileId: string;
}
