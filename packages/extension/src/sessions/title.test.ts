/**
 * Naming a conversation.
 *
 * `cleanTitle` carries most of the weight, and every rule in it is a thing
 * models do however firmly the instruction says not to: wrap the answer in
 * quotes, prefix it with "Title:", end it with a full stop. A title list where a
 * third of the rows are quoted and the rest are not looks broken in a way that
 * is hard to attribute.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_TITLE_LENGTH,
  TITLE_OUTPUT_TOKENS,
  cleanTitle,
  generateTitle,
} from "./title";
import type { CoreEvent, CoreMessage, streamTurn } from "../core/client";

/** The injectable stream, named once so the casts below stay readable. */
type Stream = typeof streamTurn;

describe("cleanTitle", () => {
  it("strips the quotes models add anyway", () => {
    expect(cleanTitle('"Wikipedia random articles"')).toBe(
      "Wikipedia random articles",
    );
    expect(cleanTitle("“Smart quotes too”")).toBe("Smart quotes too");
  });

  it("strips a Title: prefix", () => {
    expect(cleanTitle("Title: Kharua Rajapur village")).toBe(
      "Kharua Rajapur village",
    );
    expect(cleanTitle("Conversation - Two articles")).toBe("Two articles");
  });

  it("drops a trailing full stop but keeps one inside", () => {
    expect(cleanTitle("Reading en.wikipedia.org pages.")).toBe(
      "Reading en.wikipedia.org pages",
    );
  });

  it("collapses a multi-line answer into one line", () => {
    expect(cleanTitle("Random\n  Wikipedia   articles")).toBe(
      "Random Wikipedia articles",
    );
  });

  it("truncates rather than letting the drawer do it mid-word", () => {
    const long = cleanTitle("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns empty for an empty answer, so the caller keeps the derived title", () => {
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle('""')).toBe("");
  });
});

function stream(text: string) {
  const seen: Array<Record<string, unknown>> = [];
  const fn = async function* (a: Record<string, unknown>) {
    seen.push(a);
    yield { type: "text", delta: text } as CoreEvent;
    yield { type: "done", finishReason: "stop" } as CoreEvent;
  } as unknown as Stream;
  return { fn, seen };
}

const CONVERSATION: CoreMessage[] = [
  { role: "user", content: "hey what url are we on, then search something" },
  {
    role: "assistant",
    content: "You are on wikipedia.org. I opened two articles.",
  },
];

describe("generateTitle", () => {
  it("names the subject, and cleans what comes back", async () => {
    const { fn } = stream('  "Wikipedia random articles."  ');
    await expect(
      generateTitle("z-ai/glm-5.3", CONVERSATION, { stream: fn }),
    ).resolves.toBe("Wikipedia random articles");
  });

  it("sends NO tools — a title call must not go reading pages", async () => {
    const { fn, seen } = stream("A title");
    await generateTitle("m", CONVERSATION, { stream: fn });
    expect(seen[0].tools).toBeUndefined();
  });

  it("budgets enough output for a REASONING model to think first", async () => {
    // It was 32, and that is why nothing was ever named: Core 1 is GLM 5.3,
    // which spends output tokens thinking before writing any answer. The cap was
    // consumed by the thinking, `content` never began, and the caller got an
    // empty string — silently, because an unnamed conversation is not an error.
    // "Small answer, small cap" is exactly backwards on a reasoning model.
    const { fn, seen } = stream("A title");
    await generateTitle("m", CONVERSATION, { stream: fn });
    expect(seen[0].maxOutputTokens).toBe(TITLE_OUTPUT_TOKENS);
    expect(TITLE_OUTPUT_TOKENS).toBeGreaterThanOrEqual(256);
  });

  it("ignores the thinking and keeps only the answer", async () => {
    const withThinking = async function* (a: Record<string, unknown>) {
      void a;
      yield { type: "reasoning", delta: "The user asked about" } as CoreEvent;
      yield { type: "reasoning", delta: " Wikipedia articles." } as CoreEvent;
      yield { type: "text", delta: "Wikipedia random articles" } as CoreEvent;
      yield { type: "done", finishReason: "stop" } as CoreEvent;
    } as unknown as Stream;
    await expect(
      generateTitle("m", CONVERSATION, { stream: withThinking }),
    ).resolves.toBe("Wikipedia random articles");
  });

  it("returns empty when the budget ran out during the thinking", async () => {
    // The observed failure. The caller must keep the derived title rather than
    // storing a fragment of a thought.
    const truncated = async function* (a: Record<string, unknown>) {
      void a;
      yield {
        type: "reasoning",
        delta: "Let me consider what to",
      } as CoreEvent;
      yield { type: "done", finishReason: "length" } as CoreEvent;
    } as unknown as Stream;
    await expect(
      generateTitle("m", CONVERSATION, { stream: truncated }),
    ).resolves.toBe("");
  });

  it("sends only the first exchange, clipped", async () => {
    // A conversation that read six pages must not pay to be named what it paid
    // to read.
    const huge: CoreMessage[] = [
      { role: "user", content: "q".repeat(5000) },
      { role: "assistant", content: "a".repeat(5000) },
      { role: "tool", tool_call_id: "c", content: "page".repeat(20000) },
    ];
    const { fn, seen } = stream("T");
    await generateTitle("m", huge, { stream: fn });
    const sent = JSON.stringify(seen[0].messages);
    expect(sent).not.toContain("page".repeat(10));
    expect(sent.length).toBeLessThan(3000);
  });

  it("returns empty rather than throwing when Core refuses", async () => {
    // A conversation that could not be named is not a problem the user has —
    // the derived title is still there and still says something.
    const failing = async function* () {
      throw new Error("402");
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    } as unknown as Stream;
    await expect(
      generateTitle("m", CONVERSATION, { stream: failing }),
    ).resolves.toBe("");
  });

  it("does nothing at all when there is no user message yet", async () => {
    const f = vi.fn();
    await expect(
      generateTitle("m", [], {
        stream: f as unknown as Stream,
      }),
    ).resolves.toBe("");
    expect(f).not.toHaveBeenCalled();
  });
});
