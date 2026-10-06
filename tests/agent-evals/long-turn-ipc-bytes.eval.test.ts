import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * A long Build turn must not cost IPC bytes in proportion to the SQUARE of its
 * length.
 *
 * Every streamed token used to re-send the whole message list — the growing
 * turn string with every tool call and result in it, plus every earlier
 * message's frozen tool cards. A user's Mac ran out of memory on exactly such a
 * turn (2026-10-06). Main now sends the list once per stream and then patches
 * carrying only the changed tail of the live text, so the bytes sent stay a
 * small multiple of what the turn actually contains.
 */

const FILES = 30;
const FILE_BYTES = 12_000;

let ctx: EvalContext;

beforeAll(async () => {
  const seedFiles: Record<string, string> = {};
  for (let i = 0; i < FILES; i++) {
    seedFiles[`src/mod${i}.ts`] =
      `// module ${i}\n` +
      `export const v${i} = "${"x".repeat(FILE_BYTES)}";\n`;
  }
  ctx = await setupEvalContext({ seedFiles });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("long turn IPC", () => {
  it("sends bytes proportional to the turn, not to its square", async () => {
    let s = scenario("long-turn-ipc");
    for (let i = 0; i < FILES; i++)
      s = s.toolCall("read_file", { path: `src/mod${i}.ts` });
    ctx.server.register(s.text("Read all of them.").repeatLast().build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=long-turn-ipc Read every module.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const chunks = fakeIpc.sends.filter(
      (s) =>
        s.channel === "chat:response:chunk" && s.payload?.chatId === chatId,
    );
    const chunkBytes = chunks.reduce(
      (n, s) => n + JSON.stringify(s.payload).length,
      0,
    );
    const lastFull = [...chunks]
      .reverse()
      .find((s) => Array.isArray(s.payload?.messages));
    const turnChars = Math.max(
      ...(
        lastFull?.payload.messages as Array<{ role: string; content?: string }>
      )
        .filter((m) => m.role === "assistant")
        .map((m) => (m.content ?? "").length),
    );

    // IPC_BYTES_OUT=<file> records the figure (this project silences console).
    if (process.env.IPC_BYTES_OUT) {
      (await import("node:fs")).appendFileSync(
        process.env.IPC_BYTES_OUT,
        `[long-turn-ipc] ${chunks.length} chunks, ${chunkBytes} bytes for a ${turnChars}-char turn (${(chunkBytes / turnChars).toFixed(1)}x)\n`,
      );
    }
    expect(turnChars).toBeGreaterThan(FILES * FILE_BYTES);
    // Measured 2026-10-06 on this scenario: 46,472,100 bytes (125x the turn)
    // before, 1,877,743 (5.1x) after — the few full lists (start, interjections,
    // end) plus the deltas.
    expect(chunkBytes).toBeLessThan(turnChars * 10);
  }, 120_000);
});
