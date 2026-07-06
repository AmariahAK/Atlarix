import type { FakeSender } from "@/headless/fake-sender";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExecutePermission = (
  event: any,
  args: {
    chatId: number;
    operationId: string;
    approvalMode?: "once" | "deny";
  },
) => Promise<unknown>;

/**
 * Unattended approval for an automation run — the headless auto-approve model
 * with one hard difference: dangerous operations are ALWAYS denied. There is no
 * env escape hatch here (headless CI has ATLARIX_AUTONOMOUS_DANGER for
 * disposable containers; automations run on the user's real machine against
 * their real workspace, unattended, on a schedule — no one-time launch consent
 * covers that).
 */
export async function automationAutoApprove(opts: {
  sender: FakeSender;
  executePermission: ExecutePermission;
  chatId: number;
  timeoutMs: number;
}): Promise<void> {
  const { sender, executePermission, chatId, timeoutMs } = opts;
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
      const isDangerous = Boolean(
        (
          s.payload?.request as
            | { preview?: { isDangerous?: boolean } }
            | undefined
        )?.preview?.isDangerous,
      );
      const approvalMode: "once" | "deny" = isDangerous ? "deny" : "once";
      try {
        await executePermission(sender.event, { chatId, operationId, approvalMode });
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
