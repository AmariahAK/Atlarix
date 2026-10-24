/**
 * The chat each window has in front (15.11.1), so a write to the app's model
 * from a window applies to that window's chat too, whatever wrote it: the
 * composer's picker, a Settings page, a rename of the selected custom model.
 * Without it a write that went straight to `set-user-settings` moved the app's
 * default while the chat on screen kept running its stored model under a chip
 * naming the new one (QA ai-44, check 6).
 *
 * Keyed by the window's webContents id; the renderer reports a change of
 * active session (`sessions:set-front`).
 */
const front = new Map<number, string>();

export function setFrontSession(webContentsId: number, sessionId: string | null): void {
  if (sessionId) front.set(webContentsId, sessionId);
  else front.delete(webContentsId);
}

export function frontSessionOf(webContentsId: number): string | null {
  return front.get(webContentsId) ?? null;
}
