/**
 * LSP bridge — stable entry for IDE-in-the-loop helpers.
 *
 * Tool handlers are registered in {@link ../tools/lsp-tools}; this module re-exports
 * the underlying client requests for tests or future callers.
 */

export {
  ensureDocumentSyncedForLsp,
  requestLspDiagnosticsAfterSync,
  requestLspHover,
  requestLspDefinition,
  requestLspReferences,
} from "./lsp-client";
