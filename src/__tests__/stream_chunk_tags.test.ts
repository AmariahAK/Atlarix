import { describe, expect, it } from "vitest";
import {
  parseMcpToolKey,
  processStreamChunks,
} from "@/ipc/utils/stream_chunk_tags";
import { isNetworkStreamError } from "@/ipc/handlers/chat_stream/network-retry";
import {
  ProviderFinishReasonError,
  errorShapedFinishReason,
} from "@/ipc/utils/provider_finish_error";

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
    const sources = JSON.parse(match![1]) as Array<{
      url: string;
      title: string;
    }>;
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      url: "https://example.com/a",
      title: "Example A",
    });
    expect(sources[1]).toEqual({
      url: "https://grounded.dev/b",
      title: "Grounded B",
    });
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

  it("pulses renderer activity while a tool runs (no false Reconnecting)", async () => {
    async function* fullStream() {
      yield {
        type: "tool-call" as const,
        toolCallId: "tc-long",
        toolName: "run_command",
        input: { command: "npm test" },
      };
      // A long command emits no chunks for well over the renderer's reconnect
      // window; the in-flight stall-timer branch must keep pulsing.
      await new Promise((r) => setTimeout(r, 250));
      yield {
        type: "tool-result" as const,
        toolCallId: "tc-long",
        toolName: "run_command",
        output: "ok",
      };
    }
    const abortController = new AbortController();
    let pulses = 0;
    await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController,
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
      onStreamActivityPulse: () => {
        pulses += 1;
      },
      stallTimeoutMs: 60,
    });
    // At minimum the immediate tool-call-start pulse, plus in-flight ticks.
    expect(pulses).toBeGreaterThan(0);
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

  it("does NOT stall on a slow FIRST byte within the first-byte budget (reasoning/thinking)", async () => {
    // Model is slow to its first token (longer than the idle budget) but well
    // within the first-byte budget — must NOT be treated as a stall.
    async function* fullStream() {
      await new Promise((r) => setTimeout(r, 200));
      yield { type: "text-delta" as const, text: "thought, then answered" };
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
      stallTimeoutMs: 60, // idle budget — would fire if it applied pre-first-byte
      firstByteTimeoutMs: 5_000, // generous first-byte grace
    });
    expect(stalled).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
  });

  it("stall-aborts when NO first byte arrives within the first-byte budget", async () => {
    async function* fullStream() {
      await new Promise((r) => setTimeout(r, 400));
      yield { type: "text-delta" as const, text: "too late" };
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
      stallTimeoutMs: 5_000, // idle large — not the trigger
      firstByteTimeoutMs: 60, // tiny first-byte budget → fires
    });
    expect(stalled).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  it("accumulates tool-input-delta args and stops emitting once the tool-call completes", async () => {
    // Space deltas past the ~120ms emit throttle so accumulation is observable
    // (rapid synchronous deltas coalesce, which is fine in production).
    async function* fullStream() {
      yield {
        type: "tool-input-start" as const,
        toolCallId: "tc-w",
        toolName: "edit_file",
      };
      yield {
        type: "tool-input-delta" as const,
        toolCallId: "tc-w",
        inputTextDelta: '{"operation":"write",',
      };
      await new Promise((r) => setTimeout(r, 140));
      yield {
        type: "tool-input-delta" as const,
        toolCallId: "tc-w",
        inputTextDelta: '"path":"a.ts","content":"hel',
      };
      await new Promise((r) => setTimeout(r, 140));
      yield {
        type: "tool-input-delta" as const,
        toolCallId: "tc-w",
        inputTextDelta: 'lo"}',
      };
      yield {
        type: "tool-call" as const,
        toolCallId: "tc-w",
        toolName: "edit_file",
        input: { operation: "write", path: "a.ts", content: "hello" },
      };
      // A late delta after completion must NOT be emitted (buffer cleared).
      yield {
        type: "tool-input-delta" as const,
        toolCallId: "tc-w",
        inputTextDelta: "stale",
      };
    }

    const seen: string[] = [];
    await processStreamChunks({
      fullStream: fullStream() as unknown as Parameters<
        typeof processStreamChunks
      >[0]["fullStream"],
      fullResponse: "",
      abortController: new AbortController(),
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
      onToolInputDelta: ({ toolCallId, toolName, argsTextSoFar }) => {
        expect(toolCallId).toBe("tc-w");
        expect(toolName).toBe("edit_file");
        seen.push(argsTextSoFar);
      },
    });

    // At least one emission, and the accumulator only grows (never resets).
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toContain('"path":"a.ts"');
    // No emission ever contained the post-completion "stale" delta.
    expect(seen.some((s) => s.includes("stale"))).toBe(false);
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

/**
 * A provider error delivered as a SUCCESSFUL finish: HTTP 200, a well-formed
 * stream, and `finish_reason: "network_error"`. Before this, nothing threw — so
 * the retry never armed, the SDK mapped the value to "unknown", and the turn
 * ended on the structural yield proxy with a truncated answer and no error.
 */
describe("errorShapedFinishReason", () => {
  it("flags provider error reasons", () => {
    for (const raw of [
      "network_error",
      "network-error",
      "NETWORK ERROR",
      "upstream_error",
      "error",
      "timeout",
      "request_timeout",
      "service_unavailable",
      "overloaded",
      "resource_exhausted",
      "connection_reset",
      "stream_interrupted",
    ]) {
      expect(errorShapedFinishReason(raw), raw).not.toBeNull();
    }
  });

  // The deny-list direction matters: a false positive retries a COMPLETED
  // answer, doubling cost and re-running its tools. `length` and
  // `content_filter` are deterministic outcomes with their own handling, so a
  // retry would hit the identical wall.
  it("leaves good and deterministic reasons alone", () => {
    for (const raw of [
      "stop",
      "end_turn",
      "tool_calls",
      "tool-calls",
      "length",
      "max_tokens",
      "content_filter",
      "unknown",
      "",
      "   ",
    ]) {
      expect(errorShapedFinishReason(raw), raw).toBeNull();
    }
  });

  it("ignores non-strings", () => {
    for (const raw of [undefined, null, 3, {}, []]) {
      expect(errorShapedFinishReason(raw)).toBeNull();
    }
  });
});

describe("processStreamChunks + a provider error in the finish reason", () => {
  type FullStream = Parameters<typeof processStreamChunks>[0]["fullStream"];

  const run = (parts: unknown[]) => {
    async function* gen() {
      for (const p of parts) yield p;
    }
    return processStreamChunks({
      fullStream: gen() as unknown as FullStream,
      fullResponse: "",
      abortController: new AbortController(),
      chatId: -1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
    });
  };

  it("throws on a finish-step carrying an error reason", async () => {
    await expect(
      run([
        { type: "text-delta", text: "partial answ" },
        { type: "finish-step", rawFinishReason: "network_error" },
      ]),
    ).rejects.toThrow(ProviderFinishReasonError);
  });

  // A single-step round reports only `finish` — the common shape for a short
  // answer — so guarding `finish-step` alone would miss it entirely.
  it("throws on a one-step round that reports only `finish`", async () => {
    await expect(
      run([
        { type: "text-delta", text: "partial answ" },
        {
          type: "finish",
          finishReason: "unknown",
          rawFinishReason: "network_error",
        },
      ]),
    ).rejects.toThrow(/Provider finish_reason: network_error/);
  });

  it("keeps the raw string on the error for the log and breadcrumb", async () => {
    await expect(
      run([{ type: "finish", rawFinishReason: "upstream_failure" }]),
    ).rejects.toMatchObject({
      name: "ProviderFinishReasonError",
      rawFinishReason: "upstream_failure",
    });
  });

  it("does NOT throw on an ordinary finish", async () => {
    const { fullResponse } = await run([
      { type: "text-delta", text: "done." },
      { type: "finish", finishReason: "stop", rawFinishReason: "stop" },
    ]);
    expect(fullResponse).toContain("done.");
  });

  // A provider that sends no raw reason at all must behave exactly as before.
  it("does NOT throw when rawFinishReason is absent", async () => {
    const { finishReason } = await run([
      { type: "text-delta", text: "done." },
      { type: "finish", finishReason: "stop" },
    ]);
    expect(finishReason).toBe("stop");
  });

  // The whole point of throwing: the existing silent-retry path only arms for
  // errors `isNetworkStreamError` recognizes. If this ever returns false the
  // fix is inert — the turn would still end quietly, just with a stack.
  it("is classified retryable, so the existing backoff arms", () => {
    expect(
      isNetworkStreamError(new ProviderFinishReasonError("network_error")),
    ).toBe(true);
    expect(
      isNetworkStreamError(new ProviderFinishReasonError("upstream_failure")),
    ).toBe(true);
  });
});
