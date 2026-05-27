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
      fullStream: fullStream() as Parameters<
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
      fullStream: fullStream() as Parameters<
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
