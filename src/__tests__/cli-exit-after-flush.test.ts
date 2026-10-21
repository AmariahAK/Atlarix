/**
 * `atlarix keys` and `atlarix login` exit once what they queued for analytics
 * has gone (QA T1: `atlarix keys add bedrock` sent no model_connected, 2/2,
 * because the process exited before the batch did), and never wait forever.
 */
import { describe, expect, it } from "vitest";
import { exitAfterFlush } from "@/cli/exit-after-flush";

describe("exitAfterFlush", () => {
  it("flushes, then exits with the command's code", async () => {
    const order: string[] = [];
    await exitAfterFlush(3, {
      flush: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("flushed");
      },
      exit: (code) => order.push(`exit ${code}`),
    });
    expect(order).toEqual(["flushed", "exit 3"]);
  });

  it("a flush that never ends still exits, after the bound", async () => {
    const t0 = Date.now();
    let exited: number | null = null;
    await exitAfterFlush(0, { flush: () => new Promise(() => {}), exit: (c) => (exited = c), boundMs: 50 });
    expect(exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
