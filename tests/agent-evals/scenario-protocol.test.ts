import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFakeLlmServer, scenario, type FakeLlmServer } from "../infra/scenario";

/**
 * Protocol canary: AI SDK (createOpenAICompatible + streamText) against the
 * scenario server, with NO app code. If this fails, the fake server's SSE
 * shape broke; if this passes but evals fail, the bug is app-side.
 */

let server: FakeLlmServer;

beforeAll(async () => {
  server = await startFakeLlmServer();
});
afterAll(async () => {
  await server.close();
});

describe("AI SDK against scenario server", () => {
  it("streams tool_call then text through streamText", async () => {
    server.register(
      scenario("diag-1")
        .toolCall("read_thing", { path: "a.txt" })
        .text("Done reading. <task_complete>")
        .build(),
    );

    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const { streamText, jsonSchema } = await import("ai");

    const provider = createOpenAICompatible({
      name: "diag",
      baseURL: server.baseURL,
      apiKey: "test",
    });

    const result = streamText({
      model: provider("diag-model"),
      stopWhen: [() => false],
      maxRetries: 0,
      tools: {
        read_thing: {
          description: "read a thing",
          inputSchema: jsonSchema({
            type: "object",
            properties: { path: { type: "string" } },
          }),
          execute: async (args: any) => {
            console.error("DIAG tool executed:", JSON.stringify(args));
            return JSON.stringify({ ok: true, content: "thing-content" });
          },
        },
      },
      messages: [{ role: "user", content: "sc=diag-1 read the thing" }],
    });

    const parts: string[] = [];
    let text = "";
    for await (const part of result.fullStream) {
      parts.push(part.type);
      if (part.type === "text-delta") text += (part as any).text ?? (part as any).textDelta ?? "";
      if (part.type === "error") console.error("DIAG stream error:", (part as any).error);
    }
    console.error("DIAG parts:", parts.join(", "));
    console.error("DIAG text:", JSON.stringify(text));
    console.error(
      "DIAG finishReason:",
      await Promise.resolve(result.finishReason).catch(
        (e: unknown) => `REJECTED: ${e}`,
      ),
    );
    console.error("DIAG server requests:", server.requestsFor("diag-1").length);

    expect(text).toContain("Done reading.");
  }, 30_000);
});
