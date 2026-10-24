import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, getIpcHandler, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectStreamEnded } from "../infra/assert";

/**
 * 15.11.0 (ai-c8, filming; ai-26 over raw ACP): after the user denied an edit,
 * the model made the same change another way (a writer sub-agent's proposal,
 * accepted), the gate asked again, and a second "yes" landed it in the turn the
 * user had denied it. Through the real turn: the identical change, made again
 * in the same turn, is refused with NO second card; a different change to the
 * same file still gets its card (owner: that exact change only).
 */

let ctx: EvalContext;
beforeAll(async () => {
  ctx = await setupEvalContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

const write = (content: string) => ({
  operation: "write",
  path: "src/ants.js",
  content,
  description: "Add the tunnel filter",
});

describe("a denied change, made again in the same turn", () => {
  it("is refused without a card; a different change still asks", async () => {
    const denied = "export function filterByTunnel() { return 1; }\n";
    ctx.server.register(
      scenario("deny-holds")
        .toolCall("edit_file", write(denied))
        .toolCall("edit_file", write(denied)) // the same change again (a retry, or an accepted proposal)
        .toolCall("edit_file", write("export function filterByTunnel() { return 2; }\n"))
        .text("Stopping here.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    let cards = 0;
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=deny-holds Add the tunnel filter.",
      mode: "build",
      during: async (ipc) => {
        const reject = await getIpcHandler("reject-permission");
        // Card 1: the first attempt, denied by the user.
        const first = await ipc.waitFor("permission-request", (p) => p?.chatId === chatId);
        cards++;
        await reject({} as never, { chatId, operationId: first.payload.operationId });
        // The next card must be the DIFFERENT change; the identical one never asks.
        const next = await ipc.waitFor(
          "permission-request",
          (p) => p?.chatId === chatId && p.operationId !== first.payload.operationId,
        );
        cards++;
        expect(next.payload.request?.preview?.content).toContain("return 2");
        await reject({} as never, { chatId, operationId: next.payload.operationId });
      },
    });

    expect(cards).toBe(2);
    expect(ctx.ws.exists("src/ants.js")).toBe(false);
    const sent = JSON.stringify(ctx.server.requestsFor("deny-holds"));
    expect(sent).toContain("denied this exact change to");
    expectStreamEnded(fakeIpc.sends, chatId);
  }, 60_000);
});
