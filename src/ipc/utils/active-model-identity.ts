/**
 * Active model identity (per main process).
 * =========================================
 * Set at chat-stream start and cleared at stream end so git commit
 * authorship can reflect the model doing the work ("<Model> agent").
 * Outside an active stream (internal version bumps, snapshots) the
 * canonical `atlarix-agent` identity is used instead.
 */

let activeModelDisplayName: string | null = null;

export function setActiveModelDisplayName(
  name: string | null | undefined,
): void {
  const trimmed = name?.trim();
  activeModelDisplayName = trimmed ? trimmed : null;
}

export function clearActiveModelDisplayName(): void {
  activeModelDisplayName = null;
}

export function getActiveModelDisplayName(): string | null {
  return activeModelDisplayName;
}
