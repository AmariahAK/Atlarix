import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 7A — user-defined agents (.atlarix/agents/<name>.md) drive a turn:
 * the agent's system block is prepended into the header, its base mode picks
 * the tool surface, and its `tools:` allowlist intersects the offered set.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/info.ts": "export const info = 1;\n" },
  });
  // A read-only "reviewer" agent restricted to two tools.
  ctx.ws.write(
    ".atlarix/agents/reviewer.md",
    `---
description: Cautious reviewer
mode: ask
tools: [read_file, grep]
---
You are AGENT-REVIEWER-SENTINEL. Review only; never propose writes.`,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

const offeredToolNames = (req: RecordedRequest): string[] =>
  (req.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string");

describe("user-defined agents (7A)", () => {
  it("injects the agent system block and intersects its tool allowlist", async () => {
    ctx.server.register(
      scenario("agent-reviewer").text("Reviewed; looks fine.").build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=agent-reviewer Review src/info.ts.",
      mode: "build", // chat mode build, but the agent overrides to ask
      settings: { selectedAgent: "reviewer" }, // persisted-picker path
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "agent-reviewer",
    ) as RecordedRequest[];
    const first = requests[0];

    // The agent's system block reached the model.
    const systemMsg = first.messages.find((m) => m.role === "system");
    expect(JSON.stringify(systemMsg)).toContain("AGENT-REVIEWER-SENTINEL");

    // Tool allowlist intersection: ONLY the agent's two tools (∩ ask surface).
    const tools = offeredToolNames(first).sort();
    expect(tools).toEqual(["grep", "read_file"]);
    // The agent's base mode (ask) means write tools are out regardless.
    expect(tools).not.toContain("write_file");
  });
});
