import { describe, expect, it } from "vitest";
import {
  parseMcpToolKey,
  processStreamChunks,
} from "@/ipc/utils/stream_chunk_tags";

describe("parseMcpToolKey", () => {
  it("splits server__tool composite keys", () => {
    expect(parseMcpToolKey("myserver__search")).toEqual({
      serverName: "myserver",
      toolName: "search",
    });
  });

  it("returns empty server for bare tool names", () => {
    expect(parseMcpToolKey("web_search")).toEqual({
      serverName: "",
      toolName: "web_search",
    });
  });
});

describe("processStreamChunks", () => {
  it("embeds native tool-call and tool-result as atlarix tags", async () => {
    async function* fullStream() {
      yield {
        type: "tool-call" as const,
        toolCallId: "tc-1",
        toolName: "web_search",
        input: { query: "weather" },
      };
      yield {
        type: "tool-result" as const,
        toolCallId: "tc-1",
        toolName: "web_search",
        output: { hits: 3 },
      };
      yield { type: "text-delta" as const, text: "It is sunny." };
    }

    const abortController = new AbortController();
    const { fullResponse } = await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController,
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
    });

    expect(fullResponse).toContain(
      '<atlarix-tool-call tool="web_search" status="running">',
    );
    expect(fullResponse).toContain(
      '<atlarix-tool-result tool="web_search" status="complete">',
    );
    expect(fullResponse).toContain("It is sunny.");
  });

  it("flushes provider-native search sources as an <atlarix-sources> tag", async () => {
    async function* fullStream() {
      yield { type: "text-delta" as const, text: "Per the docs, " };
      yield {
        type: "source" as const,
        sourceType: "url" as const,
        id: "s1",
        url: "https://example.com/a",
        title: "Example A",
      };
      yield {
        type: "source" as const,
        sourceType: "url" as const,
        id: "s2",
        url: "https://example.com/a", // duplicate — must dedupe
        title: "Example A again",
      };
      // Gemini grounding backup path on finish-step providerMetadata.
      yield {
        type: "finish-step" as const,
        response: {},
        usage: {},
        finishReason: "stop" as const,
        providerMetadata: {
          google: {
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://grounded.dev/b", title: "Grounded B" } },
              ],
            },
          },
        },
      };
      yield { type: "text-delta" as const, text: "it works." };
    }

    const { fullResponse } = await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController: new AbortController(),
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
    });

    expect(fullResponse).toContain("Per the docs, it works.");
    const match = fullResponse.match(
      /<atlarix-sources>([\s\S]*?)<\/atlarix-sources>/,
    );
    expect(match).not.toBeNull();
    const sources = JSON.parse(match![1]) as Array<{ url: string; title: string }>;
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({ url: "https://example.com/a", title: "Example A" });
    expect(sources[1]).toEqual({ url: "https://grounded.dev/b", title: "Grounded B" });
  });

  it("emits no sources tag when the stream has no source parts", async () => {
    async function* fullStream() {
      yield { type: "text-delta" as const, text: "Plain answer." };
    }
    const { fullResponse } = await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController: new AbortController(),
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
    });
    expect(fullResponse).not.toContain("<atlarix-sources>");
  });

  it("does not stall-abort while a tool is executing locally (sub-agents, ask_user)", async () => {
    async function* fullStream() {
      yield {
        type: "tool-call" as const,
        toolCallId: "tc-slow",
        toolName: "spawn_sub_agent",
        input: { task: "explore" },
      };
      // Local tool execution: no stream chunks for far longer than the stall
      // timeout — previously this aborted the stream mid-delegation.
      await new Promise((r) => setTimeout(r, 250));
      yield {
        type: "tool-result" as const,
        toolCallId: "tc-slow",
        toolName: "spawn_sub_agent",
        output: "findings",
      };
      yield { type: "text-delta" as const, text: "Based on the sub-agent…" };
    }

    const abortController = new AbortController();
    let stallFired = false;
    const { fullResponse, stalled } = await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController,
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
      onStreamStall: () => {
        stallFired = true;
      },
      stallTimeoutMs: 60,
    });

    expect(stallFired).toBe(false);
    expect(stalled).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
    expect(fullResponse).toContain("Based on the sub-agent…");
  });

  it("still stall-aborts when the MODEL goes silent (no tool in flight)", async () => {
    async function* fullStream() {
      yield { type: "text-delta" as const, text: "Starting…" };
      await new Promise((r) => setTimeout(r, 400));
      yield { type: "text-delta" as const, text: "never delivered" };
    }
    const abortController = new AbortController();
    const { stalled } = await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController,
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
      stallTimeoutMs: 60,
    });
    expect(stalled).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  it("embeds MCP tools with server attributes", async () => {
    async function* fullStream() {
      yield {
        type: "tool-call" as const,
        toolCallId: "tc-mcp",
        toolName: "brave__search",
        input: { q: "news" },
      };
      yield {
        type: "tool-result" as const,
        toolCallId: "tc-mcp",
        toolName: "brave__search",
        output: "headlines",
      };
    }

    const { fullResponse } = await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController: new AbortController(),
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
    });

    expect(fullResponse).toContain(
      '<atlarix-mcp-tool-call server="brave" tool="search">',
    );
    expect(fullResponse).toContain(
      '<atlarix-mcp-tool-result server="brave" tool="search">',
    );
  });
});
