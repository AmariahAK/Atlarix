import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  boundNativeHistoryForPersist,
  estimateModelMessagesTokens,
  serializeNativeHistory,
} from "@/lib/ai/native-history";

/**
 * The persisted turn envelope is bounded on the way to disk, and the two things
 * that must never break while doing it:
 *
 *  1. PROVIDER PAIRING. The envelope is replayed as native tool_use / tool_result
 *     pairs. Removing a message can orphan one half of a pair, which is a 400 on
 *     the next turn — a hard failure traded for saved tokens. So the bound clips
 *     the TEXT INSIDE results and never removes anything.
 *  2. BYTE-STABILITY. The stored envelope is replayed verbatim each turn so the
 *     provider's prompt cache holds. Bounding must therefore be idempotent: a
 *     second pass over an already-bounded envelope must produce the identical
 *     bytes, or repeated saves erode the same turn and change the prefix.
 */

/** One round: an assistant tool-call plus its tool result. */
function round(id: number, resultChars: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${id}`,
          toolName: "read_file",
          input: { path: `src/file-${id}.ts` },
        },
      ],
    } as unknown as ModelMessage,
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${id}`,
          toolName: "read_file",
          output: { type: "text", value: "x".repeat(resultChars) },
        },
      ],
    } as unknown as ModelMessage,
  ];
}

function toolCallIds(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (p?.type === "tool-call" && p.toolCallId) ids.push(p.toolCallId);
    }
  }
  return ids.sort();
}

function toolResultIds(messages: ModelMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (p?.type === "tool-result" && p.toolCallId) ids.push(p.toolCallId);
    }
  }
  return ids.sort();
}

const bigTurn = (): ModelMessage[] => [
  { role: "user", content: "do the thing" } as ModelMessage,
  ...round(1, 40_000),
  ...round(2, 40_000),
  ...round(3, 40_000),
  ...round(4, 2_000),
];

describe("boundNativeHistoryForPersist", () => {
  it("gets under budget on an oversized turn", () => {
    const turn = bigTurn();
    const before = estimateModelMessagesTokens(turn);
    const budget = Math.floor(before / 4);

    const bounded = boundNativeHistoryForPersist(turn, { budgetTokens: budget });

    expect(estimateModelMessagesTokens(bounded)).toBeLessThan(before);
    expect(estimateModelMessagesTokens(bounded)).toBeLessThanOrEqual(budget);
  });

  it("never orphans a tool_use or a tool_result", () => {
    // THE invariant. Every tool-call keeps its matching result and vice versa,
    // because clipping text cannot remove a part.
    const turn = bigTurn();
    const bounded = boundNativeHistoryForPersist(turn, {
      budgetTokens: Math.floor(estimateModelMessagesTokens(turn) / 8),
    });

    expect(bounded).toHaveLength(turn.length);
    expect(toolCallIds(bounded)).toEqual(toolCallIds(turn));
    expect(toolResultIds(bounded)).toEqual(toolResultIds(turn));
    expect(toolResultIds(bounded)).toEqual(toolCallIds(bounded));
  });

  it("clips OLDEST first — the recent round keeps its detail", () => {
    const turn = bigTurn();
    const bounded = boundNativeHistoryForPersist(turn, {
      budgetTokens: Math.floor(estimateModelMessagesTokens(turn) / 3),
    });

    const valueFor = (msgs: ModelMessage[], idx: number) => {
      const parts = msgs[idx]!.content as Array<{ output?: { value?: string } }>;
      return String(parts[0]?.output?.value ?? "");
    };
    // Message 2 is round 1's result (oldest); message 8 is round 4's (newest).
    expect(valueFor(bounded, 2).length).toBeLessThan(valueFor(turn, 2).length);
    expect(valueFor(bounded, 8)).toBe(valueFor(turn, 8));
  });

  it("tells the model the text was clipped rather than leaving it empty", () => {
    const turn = bigTurn();
    const bounded = boundNativeHistoryForPersist(turn, {
      budgetTokens: Math.floor(estimateModelMessagesTokens(turn) / 8),
    });
    const parts = bounded[2]!.content as Array<{ output?: { value?: string } }>;
    const value = String(parts[0]?.output?.value ?? "");
    expect(value).toContain("clipped");
    expect(value).toContain("session_search");
    expect(value.length).toBeGreaterThan(0);
  });

  it("is IDEMPOTENT — a second pass is byte-identical (prompt cache safety)", () => {
    const turn = bigTurn();
    const budget = Math.floor(estimateModelMessagesTokens(turn) / 8);

    const once = boundNativeHistoryForPersist(turn, { budgetTokens: budget });
    const twice = boundNativeHistoryForPersist(once, { budgetTokens: budget });

    // Compared through the real serializer, because that is what gets stored and
    // what the provider replays.
    const opts = { builtinProviderId: "anthropic" as const };
    expect(serializeNativeHistory(twice, opts)).toBe(
      serializeNativeHistory(once, opts),
    );
  });

  it("stays byte-identical even when the budget can NEVER be met", () => {
    // The test above is satisfied by the early return once the total is under
    // budget. This one forces the loop to walk already-clipped messages: a budget
    // so small that even fully-clipped results exceed it, so every pass re-visits
    // every result and must still produce the same bytes.
    //
    // What makes that true is that the kept prefix is a fixed
    // `slice(0, MIN_KEPT_RESULT_CHARS)` — re-clipping a clipped value reproduces
    // it exactly. The `includes(TRUNCATION_NOTE)` early-out in the implementation
    // is NOT what holds this up: deleting it leaves these tests green. Said plainly
    // here because a comment claiming otherwise is how a later change breaks
    // stability while believing a guard protects it.
    const turn = bigTurn();
    const impossible = 10;

    const once = boundNativeHistoryForPersist(turn, { budgetTokens: impossible });
    const twice = boundNativeHistoryForPersist(once, { budgetTokens: impossible });

    const opts = { builtinProviderId: "anthropic" as const };
    expect(serializeNativeHistory(twice, opts)).toBe(
      serializeNativeHistory(once, opts),
    );
    // And the note appears exactly once per clipped result, not stacked.
    const value = String(
      (once[2]!.content as Array<{ output?: { value?: string } }>)[0]?.output
        ?.value ?? "",
    );
    expect(value.match(/clipped/g)).toHaveLength(1);
  });

  it("returns the input untouched when already within budget", () => {
    const small: ModelMessage[] = [
      { role: "user", content: "hi" } as ModelMessage,
      ...round(1, 100),
    ];
    const bounded = boundNativeHistoryForPersist(small, { budgetTokens: 1_000_000 });
    expect(bounded).toBe(small);
  });

  it("leaves plain-string and non-tool messages alone", () => {
    const turn = bigTurn();
    const bounded = boundNativeHistoryForPersist(turn, {
      budgetTokens: Math.floor(estimateModelMessagesTokens(turn) / 8),
    });
    expect(bounded[0]).toBe(turn[0]);
    // The assistant tool-CALL messages carry the model's intent, not bulk output.
    expect(bounded[1]).toBe(turn[1]);
  });

  it("does not clip a result that is already small", () => {
    // Clipping a 300-char result buys nothing and loses real detail.
    const turn: ModelMessage[] = [...round(1, 300), ...round(2, 60_000)];
    const bounded = boundNativeHistoryForPersist(turn, { budgetTokens: 500 });
    const first = bounded[1]!.content as Array<{ output?: { value?: string } }>;
    expect(String(first[0]?.output?.value ?? "")).toHaveLength(300);
  });
});
