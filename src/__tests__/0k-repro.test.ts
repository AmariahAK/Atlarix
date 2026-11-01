import { describe, expect, it } from "vitest";
import { processStreamChunks } from "@/ipc/utils/stream_chunk_tags";
import {
  parseAssistantMessageParts,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";

type FullStream = Parameters<typeof processStreamChunks>[0]["fullStream"];

function stream(parts: unknown[]): FullStream {
  async function* gen() {
    for (const p of parts) yield p;
  }
  return gen() as unknown as FullStream;
}

async function assemble(parts: unknown[]): Promise<string> {
  let last = "";
  await processStreamChunks({
    fullStream: stream(parts),
    fullResponse: "",
    abortController: new AbortController(),
    chatId: -1,
    processResponseChunkUpdate: async ({ fullResponse }) => {
      last = fullResponse;
      return fullResponse;
    },
  });
  return last;
}

/** Run parts through the real assembly, snapshotting the live parse at every
 * processResponseChunkUpdate (what each chat:response:chunk shows the user). */
async function liveTraces(parts: unknown[]): Promise<AssistantMessagePart[][]> {
  const traces: AssistantMessagePart[][] = [];
  await processStreamChunks({
    fullStream: stream(parts),
    fullResponse: "",
    abortController: new AbortController(),
    chatId: -1,
    processResponseChunkUpdate: async ({ fullResponse }) => {
      traces.push(parseAssistantMessageParts(fullResponse, true));
      return fullResponse;
    },
  });
  return traces;
}

const markdownOf = (parts: AssistantMessagePart[]): string =>
  parts.filter((p) => p.type === "markdown").map((p) => p.content).join("\n\n");
const thoughtOf = (parts: AssistantMessagePart[]): string =>
  parts.filter((p) => p.type === "thought").map((p) => p.content).join("\n\n");
const TAG = /<\/?(?:think|thinking|reasoning|redacted_thinking)\b/i;

const TOOL_EDIT = {
  type: "tool-call",
  toolCallId: "tc-1",
  toolName: "edit_file",
  input: { path: "hello.txt", operation: "write", content: "hi" },
};
const TOOL_EDIT_RESULT = {
  type: "tool-result",
  toolCallId: "tc-1",
  toolName: "edit_file",
  output: JSON.stringify({ success: true, message: "wrote hello.txt" }),
};

describe("0k: DeepSeek reasoning stays a thought while STREAMING", () => {
  it("reasoning before a tool call is CLOSED in the stored content (stream assembly)", async () => {
    const parts = [
      { type: "reasoning-delta", text: "We need to create hello.txt" },
      { type: "reasoning-delta", text: ' with content "hi".' },
      TOOL_EDIT,
      TOOL_EDIT_RESULT,
      { type: "text-delta", text: "Created **hello.txt**." },
      { type: "finish", finishReason: "stop" },
    ];
    const content = await assemble(parts);
    // The stream assembly must emit a BALANCED <think>…</think> pair around the
    // reasoning, closing it before the tool call — not leave it dangling for the
    // renderer to guess about. An open <think> swallowed the tool call + answer
    // into one thought on surfaces that lack the parser's boundary-close rule.
    expect(content.match(/<think>/g)?.length).toBe(
      content.match(/<\/think>/g)?.length,
    );
    expect(content).toContain("</think><atlarix-tool-call");
  });

  it("native reasoning-delta: reasoning is a thought, answer is prose, no tag leaks", async () => {
    const parts = [
      { type: "reasoning-start", id: "reasoning-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "The grep only found" },
      { type: "reasoning-delta", id: "reasoning-0", text: " nothing useful." },
      { type: "reasoning-end", id: "reasoning-0" },
      { type: "text-start", id: "txt-0" },
      { type: "text-delta", id: "txt-0", text: "Here is the answer." },
      { type: "text-end", id: "txt-0" },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
      expect(thoughtOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("The grep only found");
    expect(markdownOf(last)).toContain("Here is the answer.");
  });

  it("inline <redacted_thinking> text-delta: reasoning is a thought, no tag leaks", async () => {
    const parts = [
      { type: "text-start", id: "txt-0" },
      { type: "text-delta", id: "txt-0", text: "<redacted_thinking>The grep only found" },
      { type: "text-delta", id: "txt-0", text: " nothing useful.</redacted_thinking>\n\nHere is the answer." },
      { type: "text-end", id: "txt-0" },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
      expect(thoughtOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("The grep only found");
    expect(markdownOf(last)).toContain("Here is the answer.");
  });

  it("inline <reasoning> text-delta (un-normalized tag) is a thought", async () => {
    const parts = [
      { type: "text-delta", text: "<reasoning>The grep only found nothing." },
      { type: "text-delta", text: "</reasoning>\n\nHere is the answer." },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("The grep only found");
    expect(markdownOf(last)).toContain("Here is the answer.");
  });

  it("inline <think> text-delta is a thought", async () => {
    const parts = [
      { type: "text-delta", text: "<think>The grep only found nothing." },
      { type: "text-delta", text: "</think>\n\nHere is the answer." },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("The grep only found");
    expect(markdownOf(last)).toContain("Here is the answer.");
  });

  it("reasoning interleaved with a tool call stays a thought (evidence shape)", async () => {
    const parts = [
      { type: "text-delta", text: "<reasoning>We need to create hello.txt" },
      { type: "text-delta", text: ' with content "hi".</reasoning>' },
      TOOL_EDIT,
      TOOL_EDIT_RESULT,
      { type: "text-delta", text: "Created **hello.txt**." },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("We need to create hello.txt");
    expect(markdownOf(last)).toContain("Created **hello.txt**.");
    expect(last.some((p) => p.type === "tool")).toBe(true);
  });

  it("reasoning spanning a finish-step boundary is a thought on both sides", async () => {
    const parts = [
      { type: "reasoning-delta", text: "thinking part one" },
      { type: "finish-step", finishReason: "stop" },
      { type: "reasoning-delta", text: " thinking part two" },
      { type: "text-delta", text: "the answer" },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("thinking part one");
    expect(thoughtOf(last)).toContain("thinking part two");
    expect(markdownOf(last)).toContain("the answer");
  });

  it("a provider closer in the answer channel does not leak (MiniMax/DeepSeek shape)", async () => {
    const parts = [
      { type: "reasoning-delta", text: "The grep only found nothing." },
      { type: "text-delta", text: "</redacted_thinking>\n\nHere is the answer." },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("The grep only found");
    expect(markdownOf(last)).toContain("Here is the answer.");
  });

  it("reasoning-delta whose text is itself a wrapped block stays a thought", async () => {
    const parts = [
      { type: "reasoning-delta", text: "<redacted_thinking>The grep only found nothing useful.</redacted_thinking>" },
      { type: "text-delta", text: "\n\nHere is the answer." },
      { type: "finish", finishReason: "stop" },
    ];
    const traces = await liveTraces(parts);
    for (const t of traces) {
      expect(markdownOf(t)).not.toMatch(TAG);
    }
    const last = traces.at(-1)!;
    expect(thoughtOf(last)).toContain("The grep only found");
    expect(markdownOf(last)).toContain("Here is the answer.");
  });
});
