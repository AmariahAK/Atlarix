import { getIpcHandler } from "./turn";
import type { FakeIpcEvent } from "./ipc";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A `runTurn` `during` callback that approves EVERY buffered permission request
 * (file writes + commands) until the turn ends — so an unattended benchmark run
 * never blocks on the approval queue. It plays the renderer: watches the
 * recorded `permission-request` sends and invokes the real `execute-permission`
 * handler for each new operationId. The per-OS write sandbox still applies.
 *
 * Danger consent matches the shipped headless path (src/headless/auto-approve.ts):
 * dangerous commands stay blocked unless the operator set ATLARIX_AUTONOMOUS_DANGER=1.
 */
export function autoApproveDuring(
  chatId: number,
  opts?: { timeoutMs?: number },
): (ipc: FakeIpcEvent) => Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const dangerAcknowledged = process.env.ATLARIX_AUTONOMOUS_DANGER === "1";
  return async (ipc: FakeIpcEvent) => {
    const executePermission = await getIpcHandler("execute-permission");
    const seen = new Set<string>();
    let ended = false;
    const deadline = Date.now() + timeoutMs;

    const approveNew = async () => {
      for (const s of ipc.sends) {
        if (s.channel !== "permission-request") continue;
        if (s.payload?.chatId !== chatId) continue;
        const operationId = s.payload?.operationId;
        if (!operationId || seen.has(operationId)) continue;
        seen.add(operationId);
        try {
          await executePermission({} as never, { chatId, operationId, dangerAcknowledged });
        } catch {
          /* keep approving the rest even if one fails */
        }
      }
    };

    const endWatch = ipc
      .waitFor("chat:response:end", (p) => p?.chatId === chatId, timeoutMs)
      .then(() => {
        ended = true;
      })
      .catch(() => {
        ended = true;
      });

    while (!ended && Date.now() < deadline) {
      await approveNew();
      await sleep(40);
    }
    await approveNew(); // final sweep for requests that landed right before end
    await endWatch;
  };
}
