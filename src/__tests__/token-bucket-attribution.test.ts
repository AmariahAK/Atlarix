import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  bucketNativeTokensByTool,
  estimateModelMessagesTokens,
  parseNativeHistory,
  serializeNativeHistory,
} from "@/lib/ai/native-history";

/**
 * The context meter used to count only an assistant row's DISPLAY prose, while
 * the model actually receives that row's native tool history — every file body,
 * grep hit and command output. In a coding session that is most of the context,
 * so "Message History" undercounted structurally and the popover could never sum
 * to its own total.
 *
 * These lock the two properties the fix depends on:
 *   1. the buckets PARTITION the history (they are carved out, never added on
 *      top — tool results ARE history, so double-counting would double the bar);
 *   2. each tool's traffic lands in the row a user would expect.
 */

function toolResult(toolName: string, text: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call-${toolName}`,
        toolName,
        output: { type: "text", value: text },
      },
    ],
  } as unknown as ModelMessage;
}

function toolCall(toolName: string, input: unknown): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: `call-${toolName}`, toolName, input }],
  } as unknown as ModelMessage;
}

function assistantText(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as ModelMessage;
}

const BIG = (label: string, n: number) => `${label} `.repeat(n);

describe("bucketNativeTokensByTool", () => {
  it("routes each tool's traffic to the bucket a user would expect", () => {
    const b = bucketNativeTokensByTool([
      toolCall("read_file", { path: "src/a.ts" }),
      toolResult("read_file", BIG("filebody", 400)),
      toolCall("grep", { pattern: "foo" }),
      toolResult("grep", BIG("hit", 200)),
      toolCall("run_command", { command: "npm test" }),
      toolResult("run_command", BIG("stdout", 100)),
      assistantText("Here is what I found."),
    ]);

    expect(b.filesRead).toBeGreaterThan(0);
    expect(b.searchResults).toBeGreaterThan(0);
    expect(b.otherToolOutput).toBeGreaterThan(0);
    expect(b.nonTool).toBeGreaterThan(0);

    // Relative sizes follow the payloads, so a row moving means real movement.
    expect(b.filesRead).toBeGreaterThan(b.searchResults);
    expect(b.searchResults).toBeGreaterThan(b.otherToolOutput);
  });

  it("partitions the history — buckets sum to the whole estimate", () => {
    const messages = [
      toolCall("read_file", { path: "src/a.ts" }),
      toolResult("read_file", BIG("body", 50)),
      toolCall("glob", { pattern: "**/*.ts" }),
      toolResult("glob", BIG("path", 30)),
      assistantText("Done."),
    ];
    const b = bucketNativeTokensByTool(messages);
    const sum = b.filesRead + b.searchResults + b.otherToolOutput + b.nonTool;
    expect(sum).toBe(estimateModelMessagesTokens(messages));
  });

  it("groups glob with grep, and read_attachment with read_file", () => {
    const search = bucketNativeTokensByTool([toolResult("glob", BIG("x", 50))]);
    expect(search.searchResults).toBeGreaterThan(0);
    expect(search.filesRead).toBe(0);

    const files = bucketNativeTokensByTool([toolResult("read_attachment", BIG("x", 50))]);
    expect(files.filesRead).toBeGreaterThan(0);
    expect(files.searchResults).toBe(0);
  });

  it("sends an unrecognised tool to 'other' rather than dropping it", () => {
    // A newly-added tool must never vanish from the meter just because nobody
    // remembered to map it.
    const b = bucketNativeTokensByTool([toolResult("some_brand_new_tool", BIG("x", 80))]);
    expect(b.otherToolOutput).toBeGreaterThan(0);
    expect(b.filesRead + b.searchResults).toBe(0);
  });

  it("counts a plain string-content message as conversation", () => {
    const b = bucketNativeTokensByTool([
      { role: "user", content: "hello there" } as ModelMessage,
    ]);
    expect(b.nonTool).toBeGreaterThan(0);
    expect(b.filesRead + b.searchResults + b.otherToolOutput).toBe(0);
  });

  it("is empty for an empty turn", () => {
    expect(bucketNativeTokensByTool([])).toEqual({
      filesRead: 0,
      searchResults: 0,
      otherToolOutput: 0,
      nonTool: 0,
    });
  });
});

describe("bucketing survives the persisted envelope", () => {
  it("a serialized → parsed turn buckets identically to the original", () => {
    const messages = [
      toolCall("read_file", { path: "src/a.ts" }),
      toolResult("read_file", BIG("body", 120)),
      toolResult("web_search", BIG("result", 40)),
      assistantText("Summary."),
    ];
    const envelope = parseNativeHistory(serializeNativeHistory(messages));
    expect(envelope).not.toBeNull();
    expect(bucketNativeTokensByTool(envelope!.messages)).toEqual(
      bucketNativeTokensByTool(messages),
    );
  });

  it("tool history is worth far more than the prose the meter used to count", () => {
    // The whole point: the display string is a sentence, the envelope is a file.
    const prose = "Read the file and made the change.";
    const messages = [
      toolCall("read_file", { path: "src/big.ts" }),
      toolResult("read_file", BIG("line", 2000)),
      assistantText(prose),
    ];
    const b = bucketNativeTokensByTool(messages);
    expect(b.filesRead).toBeGreaterThan(b.nonTool * 20);
  });
});
