import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectToolSequence,
  expectNoStreamError,
  expectStreamEnded,
} from "../infra/assert";

/**
 * Eval 5 (Tier 4): MCP auth-fail → retry.
 *
 * mcp_call's auth-and-retry contract (src/lib/tools/mcp.ts ~L249): the first
 * client connection throws McpNeedsAuthError → the injected requireAuth
 * (requireMcpAuth) emits `mcp:auth-required` to the renderer and blocks on
 * waitForMcpAuth → the user authenticates (notifyMcpAuthUpdated) → the
 * handler disposes the client and retries ONCE → success result reaches the
 * model — all within a single mcp_call tool invocation.
 *
 * The MCP transport is faked at the mcpManager seam (no real MCP server);
 * McpNeedsAuthError stays the real class so instanceof matching is honest.
 */

const mcpFake = vi.hoisted(() => ({
  authed: false,
  getClientCalls: 0,
  disposeCalls: 0,
}));

vi.mock("@/ipc/utils/mcp_manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/ipc/utils/mcp_manager")>();
  return {
    ...actual,
    mcpManager: {
      getClient: async (serverId: number) => {
        mcpFake.getClientCalls++;
        if (!mcpFake.authed) {
          throw new actual.McpNeedsAuthError(
            serverId,
            "fake-mcp",
            "api_key",
            "missing",
          );
        }
        return {
          tools: async () => ({
            calculator_add: {
              description: "Add two numbers",
              execute: async (a: { a?: number; b?: number }) => ({
                sum: (a?.a ?? 0) + (a?.b ?? 0),
              }),
            },
          }),
        };
      },
      dispose: () => {
        mcpFake.disposeCalls++;
      },
    },
  };
});

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext();
  await ctx.testDb.db.insert(ctx.testDb.schema.mcpServers).values({
    name: "fake-mcp",
    transport: "http",
    url: "http://localhost:1/fake",
    enabled: true,
    scope: "global",
    authType: "api_key",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("MCP auth-fail → retry (build mode)", () => {
  it("pauses for auth, retries once, returns the tool result", async () => {
    ctx.server.register(
      scenario("mcp-auth")
        .toolCall("mcp_call", {
          server: "fake-mcp",
          tool: "calculator_add",
          arguments: { a: 19, b: 23 },
        })
        .text("The sum is 42.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=mcp-auth Add 19 and 23 with the MCP calculator.",
      mode: "build",
      during: async (ipc) => {
        // Renderer side: the auth prompt arrives…
        const authEvent = await ipc.waitFor(
          "mcp:auth-required",
          (p) => p?.serverName === "fake-mcp",
        );
        expect(authEvent.payload.authType).toBe("api_key");
        expect(authEvent.payload.reason).toBe("missing");

        // …the user "saves an API key" → server becomes authenticated.
        mcpFake.authed = true;
        const { notifyMcpAuthUpdated } = await import(
          "@/lib/mcp/mcp-oauth-service"
        );
        notifyMcpAuthUpdated(authEvent.payload.serverId);
      },
    });

    expectNoStreamError(fakeIpc.sends, chatId);

    // ONE mcp_call covered fail → auth → retry → success.
    expectToolSequence(fakeIpc.sends, ["mcp_call"]);
    expect(mcpFake.getClientCalls).toBe(2); // fail + retry
    expect(mcpFake.disposeCalls).toBe(1); // disposed before retry

    // The model received the real result (nested JSON escaping varies).
    const requests = ctx.server.requestsFor("mcp-auth") as any[];
    expect(JSON.stringify(requests[requests.length - 1])).toMatch(
      /sum[^0-9]{0,10}42/,
    );

    expectStreamEnded(fakeIpc.sends, chatId);
  });
});
