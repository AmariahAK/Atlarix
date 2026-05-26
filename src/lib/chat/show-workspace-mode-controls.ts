/**
 * Whether workspace message edit UI should show Mode picker + Send (vs Save only).
 * Keys off workspace binding (appId), not chat persistence or ephemeral chatId sign.
 */

export function resolveWorkspaceAppId(sources: {
  chatBoundAppId?: number | null;
  workspaceAppId?: number | null;
  selectedAppId?: number | null;
  currentAppId?: number | null;
  workspaceInfoId?: number | null;
}): number | null {
  const candidates = [
    sources.chatBoundAppId,
    sources.workspaceAppId,
    sources.selectedAppId,
    sources.currentAppId,
    sources.workspaceInfoId,
  ];
  for (const id of candidates) {
    if (id != null && !Number.isNaN(id)) {
      return id;
    }
  }
  return null;
}

export function showWorkspaceModeControls(
  message: { isSynthetic?: boolean | null },
  workspaceAppId: number | null,
): boolean {
  if (message.isSynthetic) return false;
  return workspaceAppId != null;
}
