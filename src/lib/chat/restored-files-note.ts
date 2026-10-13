/**
 * What the agent is told, with the user's next message, after the user put
 * files back without rewinding the conversation (the app's Revert on a reply;
 * the CLI and editor's files-only restore). Without it the agent builds on
 * edits that are gone. A leaf: the renderer and the CLI both use it.
 */
export function restoredFilesNote(files: string[]): string {
  return `The user restored these files to how they were before an earlier message; your edits to them since are gone: ${files.join(", ")}. Read a file again before changing it.`;
}
