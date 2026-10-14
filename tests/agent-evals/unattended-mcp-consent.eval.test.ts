import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectStreamEnded } from "../infra/assert";

/**
 * Security eval: an unattended automation run must NOT be able to drive
 * mcp_call to a server the user hasn't pre-approved (consent="always").
 * mcp_call produces no permission payload, so the injected _mcpInvocationContext
 * requireConsent is the only gate for unattended turns. Attended runs are
 * unchanged (auth-and-retry).
 */

const mcpFake = vi.hoisted(() => ({ executeCalls: 0 }));

vi.mock("@/ipc/utils/mcp_manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/ipc/utils/mcp_manager")>();
  return {
    ...actual,
    mcpManager: {
      // No editor-passed (ACP session) servers in these runs.
      listSessionServers: () => [],
      getClient: async () => ({
        tools: async () => ({
          post_message: {
            description: "Post a message to a channel",
            execute: async () => {
              mcpFake.executeCalls++;
              return { ok: true };
            },
          },
        }),
      }),
      dispose: () => {},
    },
  };
});

let ctx: EvalContext;
let serverId: number;

beforeAll(async () => {
  ctx = await setupEvalContext();
  const [row] = await ctx.testDb.db
    .insert(ctx.testDb.schema.mcpServers)
    .values({
      name: "slack-fake",
      transport: "http",
      url: "http://localhost:1/fake",
      enabled: true,
      // v14.41: `scope: "global"` here tested a shape production cannot produce.
      // Migration 0049 deleted every global row and both writers in
      // mcp_handlers.ts hardcode "workspace", so the lookup's `scope = 'global'`
      // branch was dead code that only this fixture kept alive. Bind it to the
      // eval workspace, which is what a real server looks like.
      scope: "workspace",
      appId: ctx.appId,
      authType: "none",
    })
    .returning();
  serverId = row.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function slackScenario(id: string) {
  return scenario(id)
    .toolCall("mcp_call", {
      server: "slack-fake",
      tool: "post_message",
      arguments: { channel: "#general", text: "pwned" },
    })
    .text("Done.")
    .repeatLast()
    .build();
}

describe("unattended mcp_call consent gate", () => {
  it("DENIES an unattended mcp_call with no standing consent", async () => {
    mcpFake.executeCalls = 0;
    ctx.server.register(slackScenario("mcp-noconsent"));
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=mcp-noconsent post to slack",
      mode: "ask",
      automation: { runId: "t1", unattended: true },
    });
    expect(mcpFake.executeCalls).toBe(0); // never executed
    const requests = ctx.server.requestsFor("mcp-noconsent") as any[];
    expect(
      JSON.stringify(requests[requests.length - 1]).toLowerCase(),
    ).toContain("declined");
    expectStreamEnded(fakeIpc.sends, chatId);
  });

  it("ALLOWS an unattended mcp_call when consent is 'always'", async () => {
    mcpFake.executeCalls = 0;
    await ctx.testDb.db.insert(ctx.testDb.schema.mcpToolConsents).values({
      serverId,
      toolName: "post_message",
      consent: "always",
    });
    ctx.server.register(slackScenario("mcp-consented"));
    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: "sc=mcp-consented post to slack",
      mode: "ask",
      automation: { runId: "t2", unattended: true },
    });
    expect(mcpFake.executeCalls).toBe(1); // executed under standing consent
  });
});
