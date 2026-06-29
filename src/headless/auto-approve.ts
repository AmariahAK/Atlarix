import type { FakeSender } from "./fake-sender";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExecutePermission = (
  event: any,
  args: { chatId: number; operationId: string; dangerAcknowledged?: boolean },
) => Promise<unknown>;

/**
 * Unattended approval for a headless turn: approve every buffered
 * `permission-request` (file writes + commands) via the real `execute-permission`
 * handler until the turn ends. The per-OS write sandbox still applies.
 *
 * Dangerous commands (rm -rf, sudo, …) stay blocked by DEFAULT — in the
 * interactive app a human ticks the danger checkbox, and headless has no human.
 * An operator running a disposable/unattended job can grant that consent ONCE,
 * up front, by setting ATLARIX_AUTONOMOUS_DANGER=1. That is the same consent
 * model relocated to launch time, not a headless-only bypass: the flag is read
 * explicitly (unset → blocks), so a headless run without it behaves exactly as
 * before. Benchmark CI / the PR-review bot set it; nothing auto-ons it under
 * ATLARIX_HEADLESS.
 */
export async function autoApprove(opts: {
  sender: FakeSender;
  executePermission: ExecutePermission;
  chatId: number;
  timeoutMs: number;
}): Promise<void> {
  const { sender, executePermission, chatId, timeoutMs } = opts;
  const dangerAcknowledged = process.env.ATLARIX_AUTONOMOUS_DANGER === "1";
  const seen = new Set<string>();
  let ended = false;
  const deadline = Date.now() + timeoutMs;

  const approveNew = async () => {
    for (const s of sender.sends) {
      if (s.channel !== "permission-request") continue;
      if (s.payload?.chatId !== chatId) continue;
      const operationId = s.payload?.operationId as string | undefined;
      if (!operationId || seen.has(operationId)) continue;
      seen.add(operationId);
      try {
        await executePermission(sender.event, { chatId, operationId, dangerAcknowledged });
      } catch {
        /* keep approving the rest */
      }
    }
  };

  const endWatch = sender
    .waitFor("chat:response:end", (p) => (p as { chatId?: number })?.chatId === chatId, timeoutMs)
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
  await approveNew();
  await endWatch;
}
