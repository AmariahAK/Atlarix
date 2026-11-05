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

/** All text in a message's content, whether a string or an array of parts. */
const textOf = (m: ModelMessage): string => {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(
        (p): p is { type: "text"; text: string } =>
          (p as { type?: string })?.type === "text",
      )
      .map((p) => p.text)
      .join("");
  }
  return "";
};

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
      resolveCacheMarkerPlacement(
        "bedrock",
        "anthropic.claude-sonnet-4-6-v1:0",
      ),
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
  it("message placement: breakpoints on system header + last two messages", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "HEADER",
      dynamicTail: "TAIL",
      history,
      placement: "message",
    });

    // [header, ...history] — the tail is a text part on the LAST (user) message,
    // never its own system message.
    expect(out).toHaveLength(1 + history.length);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("HEADER");
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral" });

    // Exactly one system message — the header — for every placement. A second
    // system message is what makes @ai-sdk/google ("System messages are only
    // supported at the beginning") and @ai-sdk/amazon-bedrock ("Multiple system
    // messages … separated by user/assistant") throw.
    expect(out.filter((m) => m.role === "system")).toHaveLength(1);

    // The tail rides in the last user message's content.
    const last = out.at(-1)!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    expect(textOf(last)).toBe("second questionTAIL");

    // Breakpoints on the last TWO messages (previous exchange + the new user
    // message), nowhere else.
    const historyOut = out.slice(1);
    for (const [i, m] of historyOut.entries()) {
      if (i >= historyOut.length - 2) {
        expect(cacheControlOf(m)).toEqual({ type: "ephemeral" });
      } else {
        expect(cacheControlOf(m)).toBeUndefined();
      }
    }
  });

  it("no tail and a history ending in an assistant message → the tail is its own user message", () => {
    const assistantEnding: ModelMessage[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      dynamicTail: "T",
      history: assistantEnding,
      placement: "message",
    });
    expect(out.filter((m) => m.role === "system")).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ role: "user", content: "T" });
    expect(out).toHaveLength(1 + assistantEnding.length + 1);
  });

  it("exactly one system message (the header) for every placement", () => {
    // @ai-sdk/google throws on any system message after the start, and
    // @ai-sdk/amazon-bedrock on multiple system messages separated by turns, so
    // a single leading system message is the invariant that keeps both providers
    // (and every other) converting without throwing.
    for (const placement of ["message", "content", "none"] as const) {
      const out = buildStreamMessagesWithCacheBreakpoints({
        systemHeader: "H",
        dynamicTail: "T",
        history,
        placement,
      });
      const systems = out.filter((m) => m.role === "system");
      expect(systems).toHaveLength(1);
      expect(systems[0]!.content).toBe("H");
      // The tail rides in the last user message, never a second system message.
      expect(out.at(-1)!.role).toBe("user");
      expect(textOf(out.at(-1)!)).toContain("T");
    }
  });

  it("keeps the prefix byte-identical across turns (tail merged into the newest user message)", () => {
    const u = (s: string): ModelMessage => ({ role: "user", content: s });
    const a = (s: string): ModelMessage => ({ role: "assistant", content: s });
    const turn1 = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "HEADER",
      dynamicTail: "TAIL-1",
      history: [u("first question"), a("first answer"), u("second question")],
      placement: "message",
    });
    const turn2 = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "HEADER",
      dynamicTail: "TAIL-2",
      history: [
        u("first question"),
        a("first answer"),
        u("second question"),
        a("second answer"),
        u("third question"),
      ],
      placement: "message",
    });

    // Everything BEFORE the newest user message is byte-identical between the
    // two turns — the whole point of keeping the tail out of the cacheable
    // prefix. Compare role + content only (cache markers are control signals).
    const shape = (m: ModelMessage) => ({ role: m.role, content: m.content });
    expect(shape(turn1[0])).toEqual(shape(turn2[0])); // header
    expect(shape(turn1[1])).toEqual(shape(turn2[1])); // first question
    expect(shape(turn1[2])).toEqual(shape(turn2[2])); // first answer

    // The per-turn tail still reaches the model — this turn's, in the newest
    // user message.
    expect(textOf(turn1.at(-1)!)).toContain("TAIL-1");
    expect(textOf(turn2.at(-1)!)).toContain("TAIL-2");
    expect(turn1.at(-1)!.role).toBe("user");
    expect(turn2.at(-1)!.role).toBe("user");
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
    // History objects pass through unmodified (same references) — except the
    // last user message, which is a copy carrying the tail.
    expect(out[1]).toBe(history[0]);
    expect(out[2]).toBe(history[1]);
    expect(out[3]).not.toBe(history[2]);
    expect(out).toHaveLength(1 + history.length);
    expect(textOf(out[3])).toBe("second questionT");
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

  it("headerTtl1h (the main conversation): 1h TTL on the header AND history anthropic markers", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({
      systemHeader: "H",
      history,
      placement: "message",
      headerTtl1h: true,
    });
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    // Other provider keys on the header keep the plain marker.
    expect(openRouterCacheControlOf(out[0])).toEqual({ type: "ephemeral" });
    // History breakpoints are 1h too (2026-11-05, as Claude Code): a reply
    // after 5-60 min reads the history from cache. Anthropic wants 1h before 5m.
    expect(cacheControlOf(out[out.length - 1])).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(openRouterCacheControlOf(out[out.length - 1])).toEqual({ type: "ephemeral" });
  });

  it("without headerTtl1h (a sub-agent): every marker is the 5m default", () => {
    const out = buildStreamMessagesWithCacheBreakpoints({ systemHeader: "H", history, placement: "message" });
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral" });
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
    const out = advanceCacheBreakpointsForStep(initial(), "message", true);
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(cacheControlOf(out[1])).toBeUndefined(); // q1 — outside the last two
    expect(cacheControlOf(out[2])).toEqual({ type: "ephemeral", ttl: "1h" }); // a1
    expect(cacheControlOf(out[3])).toEqual({ type: "ephemeral", ttl: "1h" }); // q2+tail
  });

  it("later steps: markers move to the new last two, old positions stripped", () => {
    const stepMessages: ModelMessage[] = [
      ...initial(),
      { role: "assistant", content: "tool call round" },
      {
        role: "tool",
        content: [{ type: "tool-result" }],
      } as unknown as ModelMessage,
    ];
    const out = advanceCacheBreakpointsForStep(stepMessages, "message", true);
    // Header keeps its 1h marker.
    expect(cacheControlOf(out[0])).toEqual({ type: "ephemeral", ttl: "1h" });
    // Old history breakpoints (a1, q2+tail) stripped.
    expect(cacheControlOf(out[2])).toBeUndefined();
    expect(cacheControlOf(out[3])).toBeUndefined();
    // New last two marked (assistant + tool), 1h like the header.
    expect(cacheControlOf(out[4])).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(cacheControlOf(out[5])).toEqual({ type: "ephemeral", ttl: "1h" });
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
