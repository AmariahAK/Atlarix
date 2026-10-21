/**
 * Exit a one-shot command (`atlarix keys`, `atlarix login`) once what it queued
 * for analytics has gone, bounded. These exited straight away, so the
 * `model_connected` a saved key or a sign-in queued was never sent: the client
 * batches up to 30 s (QA T1, `atlarix keys add bedrock`, 2/2).
 */
export async function exitAfterFlush(
  code: number,
  deps: { flush?: () => Promise<void>; exit?: (code: number) => void; boundMs?: number } = {},
): Promise<void> {
  const flush =
    deps.flush ??
    (async () => {
      const { flushAndClose } = await import("../main/lib/analytics");
      await flushAndClose();
    });
  await Promise.race([flush().catch(() => {}), new Promise((r) => setTimeout(r, deps.boundMs ?? 1500).unref?.())]);
  (deps.exit ?? process.exit)(code);
}
