/**
 * A7: a refused computer action on the NATIVE Anthropic lane (computer_20251124)
 * must reach the model as an error tool_result, the same as on our own tool.
 * Real AI SDK + Anthropic provider; only the network is faked.
 */
import { describe, expect, it, vi } from "vitest";
import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

vi.mock("@/lib/tools/computer", async (orig) => ({
  ...(await orig<object>()),
  computerDisplaySize: async () => ({ width: 1280, height: 800 }),
}));

const BUSY = "another Atlarix session is controlling the screen";

describe("a refused native computer action", () => {
  it("is sent back as is_error with the reason as text", async () => {
    const { nativeComputerTool } = await import("@/lib/computer/native");
    const { computerFailureOutput } = await import("@/lib/tools/computer");
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const content =
        bodies.length === 1
          ? [{ type: "tool_use", id: "toolu_1", name: "computer", input: { action: "mouse_move", coordinate: [10, 20] } }]
          : [{ type: "text", text: "ok" }];
      return new Response(
        JSON.stringify({
          id: `msg_${bodies.length}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content,
          stop_reason: bodies.length === 1 ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    // What the build turn hands the SDK: execute -> the wrapper's JSON TEXT;
    // toModelOutput -> computerFailureOutput first (build-branch.ts).
    const own = {
      execute: async () => JSON.stringify({ success: false, tool: "computer", error: BUSY, message: BUSY }),
      toModelOutput: ({ output }: { output: unknown }) =>
        computerFailureOutput("computer", output) ?? { type: "text" as const, value: String(output) },
    };
    const computer = await nativeComputerTool("native-anthropic", own as never);
    const model = createAnthropic({ apiKey: "test", fetch: fakeFetch })("claude-haiku-4-5");
    await generateText({ model, tools: { computer }, prompt: "move the mouse", stopWhen: stepCountIs(2) });

    expect((bodies[0]!.tools as Array<{ type: string }>)[0]!.type).toBe("computer_20251124");
    const sent = JSON.stringify(bodies[1]!.messages);
    const result = (bodies[1]!.messages as Array<{ content: Array<Record<string, unknown>> }>)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_result")!;
    expect(result.is_error).toBe(true);
    expect(sent).toContain(BUSY);
    expect(sent).not.toContain('\\"success\\":false');
  });
});
