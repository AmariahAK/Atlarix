import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  advanceCacheBreakpointsForStep,
  buildStreamMessagesWithCacheBreakpoints,
  resolveCacheMarkerPlacement,
} from "@/lib/ai/anthropic-cache-breakpoints";

/**
 * Tier 4 eval 6: provider message-shape — prompt-cache breakpoints.
 *
 * NOTE: this is deliberately a unit test, not a chat:stream agent eval — the
 * agent-eval fake server speaks OpenAI protocol, so marker placement can never
 * be exercised through that seam. The layout function is extracted from
 * simpleStreamText precisely so this shape is pinned here.
 */

const cacheControlOf = (m: ModelMessage) =>
  (m as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
    .providerOptions?.anthropic?.cacheControl;

const openRouterCacheControlOf = (o: unknown) =>
  (o as { providerOptions?: { openrouter?: { cacheControl?: unknown } } })
    ?.providerOptions?.openrouter?.cacheControl;

const history: ModelMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

describe("resolveCacheMarkerPlacement", () => {
  it("direct anthropic → message-level regardless of model name", () => {
    expect(resolveCacheMarkerPlacement("anthropic", "claude-sonnet-4-6")).toBe(
      "message",
    );
    expect(resolveCacheMarkerPlacement("anthropic", undefined)).toBe("message");
  });

  it("claude-family on routed providers → content-level", () => {
    expect(
      resolveCacheMarkerPlacement("openrouter", "anthropic/claude-sonnet-4.6"),
    ).toBe("content");
    expect(
      resolveCacheMarkerPlacement("compass", "anthropic/claude-haiku-4.5"),
    ).toBe("content");
    // custom OpenAI-compatible proxy serving a claude model
    expect(resolveCacheMarkerPlacement("my-litellm", "claude-opus-4-8")).toBe(
      "content",
    );
  });

  it("claude-family on bedrock/vertex → message-level", () => {
    expect(
      resolveCacheMarkerPlacement("bedrock", "anthropic.claude-sonnet-4-6-v1:0"),
    ).toBe("message");
    expect(resolveCacheMarkerPlacement("vertex", "claude-sonnet-4-6")).toBe(
      "message",
    );
  });

  it("non-claude models → none (automatic-caching providers untouched)", () => {
    expect(resolveCacheMarkerPlacement("openai", "gpt-5")).toBe("none");
    expect(resolveCacheMarkerPlacement("google", "gemini-3-pro")).toBe("none");
    expect(resolveCacheMarkerPlacement("openrouter", "openai/gpt-5")).toBe(
      "none",
    );
    expect(resolveCacheMarkerPlacement("ollama", "llama3.3:70b")).toBe("none");
    expect(resolveCacheMarkerPlacement(undefined, undefined)).toBe("none");
  });
});

describe("buildStreamMessagesWithCacheBreakpoints", () => {
  it("message placement: breakpoints on system header + last two history messages", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "HEADER",
      dynamicTail: "TAIL",
      history,
      placement: "message",
    });

    // [header, tail, ...history]
    expect(out).toHaveLength(2 + history.length);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("HEADER");
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral" });

    // Tail is its own system message with NO breakpoint (it changes daily).
    expect(out[1].role).toBe("system");
    expect(out[1].content).toBe("TAIL");
    expect(cacheControlOf(out[1])).toBeUndefined();

    // Breakpoints on the last TWO history messages (previous exchange tail +
    // the new user message), nowhere else.
    const historyOut = out.slice(2);
    for (const [i, m] of historyOut.entries()) {
      if (i >= historyOut.length - 2) {
        expect(cacheControlOf(m)).toEqual({ type: "ephemeral" });
      } else {
        expect(cacheControlOf(m)).toBeUndefined();
      }
    }
  });

  it("marker carries all provider keys at once (openrouter/bedrock/openaiCompatible)", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history,
      placement: "message",
    });
    const header = out[0] as { providerOptions?: Record<string, unknown> };
    expect(header.providerOptions?.anthropic).toEqual({
      cacheControl: { type: "ephemeral" },
    });
    expect(header.providerOptions?.openrouter).toEqual({
      cacheControl: { type: "ephemeral" },
    });
    expect(header.providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    });
    expect(header.providerOptions?.openaiCompatible).toEqual({
      cache_control: { type: "ephemeral" },
    });
  });

  it("content placement: marker lands on the LAST content part of array-content messages", () => {
    const nativeHistory: ModelMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      } as ModelMessage,
      {
        role: "user",
        content: [{ type: "text", text: "q2" }],
      } as ModelMessage,
    ];
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history: nativeHistory,
      placement: "content",
    });

    // Header content is a string → message-level fallback.
    expect(openRouterCacheControlOf(out[0])).toEqual({ type: "ephemeral" });

    const hist = out.slice(1);
    const assistant = hist[1] as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(openRouterCacheControlOf(assistant.content[0])).toBeUndefined();
    expect(openRouterCacheControlOf(assistant.content[1])).toEqual({
      type: "ephemeral",
    });
    // Message itself NOT marked when parts were markable.
    expect(openRouterCacheControlOf(hist[1])).toBeUndefined();

    const lastUser = hist[2] as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(openRouterCacheControlOf(lastUser.content[0])).toEqual({
      type: "ephemeral",
    });
    // First history message untouched, same reference.
    expect(hist[0]).toBe(nativeHistory[0]);
  });

  it("content placement: string-content history falls back to message-level", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history,
      placement: "content",
    });
    const hist = out.slice(1);
    expect(openRouterCacheControlOf(hist[hist.length - 1])).toEqual({
      type: "ephemeral",
    });
  });

  it("history breakpoint preserves existing providerOptions", () => {
    const withOptions: ModelMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "a",
        providerOptions: { anthropic: { custom: true } } as any,
      },
      { role: "user", content: "q2" },
    ];
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history: withOptions,
      placement: "message",
    });
    const target = out[out.length - 2] as any;
    // history[len-2] is the assistant message with pre-existing options —
    // the spread keeps the providerOptions key but the marker object replaces
    // its anthropic entry wholesale (matches the original inline behavior).
    expect(target.providerOptions.anthropic.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  it("single-message history gets a breakpoint (first-turn cache write)", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history: [{ role: "user", content: "only" }],
      placement: "message",
    });
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(out[1])).toEqual({ type: "ephemeral" });
  });

  it("none placement: no markers anywhere, history passes through by reference", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      dynamicTail: "T",
      history,
      placement: "none",
    });
    for (const m of out) {
      expect(cacheControlOf(m)).toBeUndefined();
      expect(openRouterCacheControlOf(m)).toBeUndefined();
    }
    // History objects pass through unmodified (same references).
    expect(out.slice(2)).toEqual(history);
    expect(out[2]).toBe(history[0]);
  });

  it("omits the tail message when dynamicTail is null or blank", () => {
    for (const tail of [null, "", "   "]) {
      const out = buildStreamMessagesWithCacheBreakpoints({
        systemHeader: "H",
        dynamicTail: tail,
        history,
        placement: "message",
      });
      expect(out).toHaveLength(1 + history.length);
      expect(out[1].role).toBe("user"); // tail skipped — history follows header
    }
  });

  it("marked history messages are copies — originals are not mutated", () => {
    const original: ModelMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      {
        role: "user",
        content: [{ type: "text", text: "q2" }],
      } as ModelMessage,
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history: original,
      placement: "content",
    });
    expect(original).toEqual(snapshot);
  });

  it("headerTtl1h: 1h TTL on the header's anthropic marker only", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history,
      placement: "message",
      headerTtl1h: true,
    });
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    // Other provider keys on the header keep the plain marker.
    expect(openRouterCacheControlOf(out[0])).toEqual({ type: "ephemeral" });
    // History breakpoints stay 5m (no ttl).
    expect(cacheControlOf(out[out.length - 1])).toEqual({ type: "ephemeral" });
  });
});

describe("advanceCacheBreakpointsForStep (v13.3 per-step advancement)", () => {
  const initial = () =>
    buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      dynamicTail: "T",
      history: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
      placement: "message",
      headerTtl1h: true,
    });

  it("step 0 is position-stable: same marker layout as the initial build", () => {
    const out = advanceCacheBreakpointsForStep(initial(), "message");
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(cacheControlOf(out[1])).toBeUndefined(); // tail
    expect(cacheControlOf(out[2])).toBeUndefined();
    expect(cacheControlOf(out[3])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(out[4])).toEqual({ type: "ephemeral" });
  });

  it("later steps: markers move to the new last two, old positions stripped", () => {
    const stepMessages: ModelMessage[] = [
      ...initial(),
      { role: "assistant", content: "tool call round" },
      { role: "tool", content: [{ type: "tool-result" }] } as unknown as ModelMessage,
    ];
    const out = advanceCacheBreakpointsForStep(stepMessages, "message");
    // Header keeps its 1h marker; tail untouched.
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    // Old history breakpoints (idx 3,4) stripped.
    expect(cacheControlOf(out[3])).toBeUndefined();
    expect(cacheControlOf(out[4])).toBeUndefined();
    // New last two marked.
    expect(cacheControlOf(out[5])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(out[6])).toEqual({ type: "ephemeral" });
    // Exactly 3 breakpoints total (≤4 Anthropic limit).
    const marked = out.filter((m) => cacheControlOf(m) != null);
    expect(marked).toHaveLength(3);
  });

  it("stripping preserves co-resident providerOptions (reasoning fields survive)", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "H" },
      {
        role: "assistant",
        content: "a",
        providerOptions: {
          openaiCompatible: {
            cache_control: { type: "ephemeral" },
            reasoning_content: "kept",
          },
          customKey: { untouched: true },
        },
      } as ModelMessage,
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
    ];
    const out = advanceCacheBreakpointsForStep(messages, "content");
    const assistant = out[1] as {
      providerOptions?: Record<string, Record<string, unknown>>;
    };
    expect(assistant.providerOptions?.openaiCompatible).toEqual({
      reasoning_content: "kept",
    });
    expect(assistant.providerOptions?.customKey).toEqual({ untouched: true });
  });

  it("none placement: messages pass through by reference", () => {
    const msgs = initial();
    expect(advanceCacheBreakpointsForStep(msgs, "none")).toBe(msgs);
  });

  it("does not mutate its input", () => {
    const msgs = initial();
    const snapshot = JSON.parse(JSON.stringify(msgs));
    advanceCacheBreakpointsForStep(
      [...msgs, { role: "assistant", content: "x" }],
      "message",
    );
    expect(msgs).toEqual(snapshot);
  });
});
