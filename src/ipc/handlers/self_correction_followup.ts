/**
 * Post-turn self-correction: optional follow-up stream when TSC / dev output / tests indicate issues.
 * Shared cap: max 2 auto-correction user messages per root assistant turn (key: chatId:rootAssistantId).
 */

import type { WebContents } from "electron";

const correctionAttempts = new Map<string, number>();
/** Assistant message id from the pre-correction turn; reused for cap while the chain continues. */
const pendingSelfCorrectionRootByChatId = new Map<number, number>();

export function clearSelfCorrectionAttemptsForChat(chatId: number): void {
  pendingSelfCorrectionRootByChatId.delete(chatId);
  for (const k of Array.from(correctionAttempts.keys())) {
    if (k.startsWith(`${chatId}:`)) correctionAttempts.delete(k);
  }
}

/**
 * Queue a synthetic user message under the same cap as TSC/dev/test self-correction (max 2 per root turn).
 * Used for build verification follow-ups; does not run problem report / dev server / tests.
 */
export async function enqueueSyntheticFollowUpIfUnderCap(_opts: {
  webContents: WebContents;
  chatId: number;
  rootAssistantMessageId: number;
  content: string;
  label: string;
}): Promise<boolean> {
  return false;
}

export async function schedulePostTurnSelfCorrection(opts: {
  webContents: WebContents;
  chatId: number;
  rootAssistantMessageId: number;
  appId: number | undefined;
  appPathResolved: string;
  filesWrittenInThisExchange: string[];
  isBuildModeTurn: boolean;
  isEphemeralWorkspace: boolean;
  aborted: boolean;
  /** True while this chat still has an active chat:stream (re-entrancy guard). */
  isStreamActive?: () => boolean;
}): Promise<void> {
  if (opts.aborted) return;
  // Workspace streams are ephemeral-only; DB-backed self-correction removed.
  if (opts.isEphemeralWorkspace) return;
  if (!opts.isBuildModeTurn) return;
}
