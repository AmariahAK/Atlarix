/**
 * The turn's request reaches the model once, as the user message, and the
 * per-turn system tail stays the same from turn to turn (owner, 2026-10-21).
 *
 * The tail carried the request again as `<user_context>`, so it changed every
 * turn, and the history after it was never read from the prompt cache: on
 * Bedrock Haiku 4.5 turns 2 and 3 read only the header and rewrote the rest.
 * A resumed interrupted turn has no user message of its own: its directive
 * still goes in the tail, so it must not be lost.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupEvalContext, runTurn, getIpcHandler, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { makeFakeIpcEvent } from "../infra/ipc";

let ctx: EvalContext;
beforeAll(async () => {
  ctx = await setupEvalContext();
});
afterAll(async () => {
  await ctx.cleanup();
});

type Msg = { role: string; content: unknown };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const firstRequest = (id: string, nth = 0) => (ctx.server.requestsFor(id) as Array<{ messages: Msg[] }>)[nth]!;

describe.each(["build", "ask"] as const)("%s: the request", (mode) => {
  it("is in the user message once, and in no system message", async () => {
    const id = `req-once-${mode}`;
    ctx.server.register(scenario(id).text("Done.").repeatLast().build());
    const marker = `MARKER-${mode}-71`;
    await runTurn(ctx, { chatId: await ctx.newChat(), prompt: `sc=${id} please look at ${marker}`, mode });
    const { messages } = firstRequest(id);
    const system = messages.filter((m) => m.role === "system").map(text).join("\n");
    const user = messages.filter((m) => m.role === "user").map(text).join("\n");
    expect(system).not.toContain(marker);
    expect(system).not.toContain("<user_context>");
    expect(count(user, marker)).toBe(1);
  });
});

describe("the per-turn system tail", () => {
  it("is byte-identical on the next turn of the same chat", async () => {
    const id = "tail-stable";
    ctx.server.register(scenario(id).text("Ok.").repeatLast().build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, { chatId, prompt: `sc=${id} first request ONE`, mode: "build" });
    await runTurn(ctx, { chatId, prompt: `sc=${id} second request TWO`, mode: "build" });
    const reqs = ctx.server.requestsFor(id) as Array<{ messages: Msg[] }>;
    const systems = (r: { messages: Msg[] }) => r.messages.filter((m) => m.role === "system").map(text);
    const first = systems(reqs[0]!);
    const last = systems(reqs[reqs.length - 1]!);
    expect(first.length).toBeGreaterThan(0);
    expect(last).toEqual(first);
  });
});

describe("a resumed interrupted turn", () => {
  it("still tells the model to continue (its only copy is the tail)", async () => {
    const id = "resume-directive";
    ctx.server.register(scenario(id).text("Continuing.").repeatLast().build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, { chatId, prompt: `sc=${id} write a long answer`, mode: "build" });
    const before = ctx.server.requestsFor(id).length;
    const fakeIpc = makeFakeIpcEvent();
    const handler = await getIpcHandler("chat:stream");
    await handler(fakeIpc.event, { chatId, prompt: "", continueInterrupted: true });
    await fakeIpc.waitFor("chat:response:end", (p) => p?.chatId === chatId, 30_000);
    const reqs = ctx.server.requestsFor(id) as Array<{ messages: Msg[] }>;
    expect(reqs.length).toBeGreaterThan(before);
    expect(JSON.stringify(reqs[before]!.messages)).toContain("Continue from where you left off");
  });
});
