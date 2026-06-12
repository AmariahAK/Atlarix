/**
 * v13 Phase 7A — background command results.
 *
 * `run_command({ background: true })` returns to the model immediately; the
 * command keeps running in the interceptor. When it exits, the result lands
 * here and is delivered back to the model:
 *  - mid-turn via the engine's prepareStep injection (the same seam the
 *    repetition corrections use), or
 *  - on the NEXT turn as a context section, when the turn already ended.
 * No polling tool — the model is "re-invoked when it exits" (Claude Code's
 * run_in_background contract).
 */

export type BackgroundCommandResult = {
  command: string;
  exitCode: number;
  /** Tail of combined stdout/stderr (capped). */
  output: string;
  durationMs: number;
  finishedAt: number;
};

const OUTPUT_TAIL_CAP = 8_000;
const MAX_QUEUED_PER_CHAT = 10;

const resultsByChat = new Map<number, BackgroundCommandResult[]>();
/** Commands still running per chat (for "is anything pending" checks). */
const runningByChat = new Map<number, Set<string>>();

export function recordBackgroundCommandStart(
  chatId: number,
  operationId: string,
): void {
  const set = runningByChat.get(chatId) ?? new Set<string>();
  set.add(operationId);
  runningByChat.set(chatId, set);
}

export function recordBackgroundCommandResult(
  chatId: number,
  operationId: string,
  result: Omit<BackgroundCommandResult, "finishedAt">,
): void {
  runningByChat.get(chatId)?.delete(operationId);
  const list = resultsByChat.get(chatId) ?? [];
  list.push({
    ...result,
    output:
      result.output.length > OUTPUT_TAIL_CAP
        ? `…${result.output.slice(-OUTPUT_TAIL_CAP)}`
        : result.output,
    finishedAt: Date.now(),
  });
  resultsByChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
}

export function hasRunningBackgroundCommands(chatId: number): boolean {
  return (runningByChat.get(chatId)?.size ?? 0) > 0;
}

/**
 * Take-once drain of finished background command results, formatted as a
 * model-facing block. Returns null when nothing is pending.
 */
export function takePendingBackgroundCommandResults(
  chatId: number,
): string | null {
  const list = resultsByChat.get(chatId);
  if (!list?.length) return null;
  resultsByChat.delete(chatId);
  const blocks = list.map((r) => {
    const status = r.exitCode === 0 ? "succeeded" : `failed (exit ${r.exitCode})`;
    return [
      `Background command ${status} after ${(r.durationMs / 1000).toFixed(1)}s:`,
      `$ ${r.command}`,
      r.output ? "```\n" + r.output + "\n```" : "(no output)",
    ].join("\n");
  });
  return `[Background command results]\n\n${blocks.join("\n\n")}`;
}

export function clearBackgroundCommandsForChat(chatId: number): void {
  resultsByChat.delete(chatId);
  runningByChat.delete(chatId);
}
