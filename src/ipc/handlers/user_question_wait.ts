/**
 * Blocks tool execution until the user submits an answer for ask_user (renderer → IPC).
 */
import log from "electron-log";

const logger = log.scope("user-question-wait");

const pending = new Map<string, { resolve: (s: string) => void; timeout: NodeJS.Timeout }>();

function waitKey(chatId: number, questionId: string): string {
  return `${chatId}:${questionId}`;
}

export function waitForUserQuestionAnswer(
  chatId: number,
  questionId: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    const k = waitKey(chatId, questionId);
    const t = setTimeout(() => {
      pending.delete(k);
      logger.warn(`User question timed out: ${k}`);
      resolve("(timed out waiting for user answer)");
    }, timeoutMs);
    pending.set(k, { resolve, timeout: t });
  });
}

export function resolveUserQuestionAnswer(chatId: number, questionId: string, answer: string): boolean {
  const k = waitKey(chatId, questionId);
  const p = pending.get(k);
  if (!p) {
    logger.warn(`No pending user question for ${k}`);
    return false;
  }
  clearTimeout(p.timeout);
  pending.delete(k);
  p.resolve(answer);
  return true;
}
