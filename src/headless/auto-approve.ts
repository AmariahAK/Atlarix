import type { FakeSender } from "./fake-sender";

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
 * Unattended approval for a headless turn: approve every buffered
 * `permission-request` (file writes + commands) via the real `execute-permission`
 * handler until the turn ends. The per-OS write sandbox still applies.
 *
 * Dangerous commands (rm -rf, sudo, git push --force, …) stay blocked by DEFAULT
 * — in the interactive app a human approves them, and headless has no human. An
 * operator running a disposable/unattended job can grant that consent ONCE, up
 * front, by setting ATLARIX_AUTONOMOUS_DANGER=1. That is the same consent model
 * relocated to launch time, not a headless-only bypass: the flag is read
 * explicitly (unset → we DENY dangerous ops), so a headless run without it
 * behaves exactly as before. Benchmark CI / the PR-review bot set it; nothing
 * auto-ons it under ATLARIX_HEADLESS. (Since the interactive hard-floor throw was
 * removed, this deny is what upholds the "no silent dangerous exec" invariant in
 * headless mode.)
 */
export async function autoApprove(opts: {
  sender: FakeSender;
  executePermission: ExecutePermission;
  chatId: number;
  timeoutMs: number;
}): Promise<void> {
  const { sender, executePermission, chatId, timeoutMs } = opts;
  const dangerAllowed = process.env.ATLARIX_AUTONOMOUS_DANGER === "1";
  const seen = new Set<string>();
  let ended = false;
  const deadline = Date.now() + timeoutMs;

  // Resume point into `sender.sends`, which is append-only. Rescanning from 0 on
  // every 40ms tick is quadratic over the run, and `sends` retains EVERY ipc send
  // (including each unthrottled response chunk). That was survivable only while a
  // 10-minute self-timeout capped the run; with the deadline now owned by the
  // orchestrator — 8 hours on Terminal-Bench 4.0 — the array reaches hundreds of
  // thousands of entries and the rescan starts costing more than the work.
  let scanned = 0;

  const approveNew = async () => {
    // Snapshot the length first: `sends` can grow while we await below, and those
    // late arrivals belong to the next pass, not this index range.
    const end = sender.sends.length;
    for (; scanned < end; scanned++) {
      const s = sender.sends[scanned];
      if (s.channel !== "permission-request") continue;
      if (s.payload?.chatId !== chatId) continue;
      const operationId = s.payload?.operationId as string | undefined;
      if (!operationId || seen.has(operationId)) continue;
      seen.add(operationId);
      const preview = (
        s.payload?.request as
          | { preview?: { isDangerous?: boolean; systemScope?: boolean } }
          | undefined
      )?.preview;
      const isDangerous = Boolean(preview?.isDangerous);
      // `systemScope` marks something that outlives this run and reaches beyond
      // the workspace — granting a folder write access is the case that matters
      // here. `--dangerously-*` opts into destructive ACTIONS inside the task, not
      // into permanently widening what the app may touch afterwards, so this is
      // denied even then. Matches the automations path, which denies on the same
      // flag, and keeps headless behaving exactly as it did before grants existed.
      const isSystemScope = Boolean(preview?.systemScope);
      const approvalMode: "once" | "deny" =
        isSystemScope || (isDangerous && !dangerAllowed) ? "deny" : "once";
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
