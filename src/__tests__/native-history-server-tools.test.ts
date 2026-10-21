/**
 * A provider's own tool (Anthropic's web search) must never be saved or replayed
 * without its result.
 *
 * THE BUG (owner, CLI, 2026-10-19): Claude called web_search AND read_url in one
 * step. Anthropic answers the server search in the NEXT step, so ai@7 puts the
 * `web_search` result at the head of that step's assistant message (measured
 * against the live API). The next step was an ask_user that ended the turn, and a
 * turn that ends that way does not keep its last step, so the saved history held
 * the call and not the result. Every later message in the chat then failed:
 *
 *   messages.1: `web_search` tool use with id `srvtoolu_…` was found without a
 *   corresponding `web_search_tool_result` block
 */

import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { parseNativeHistory, serializeNativeHistory } from "@/lib/ai/native-history";

const serverCall = { type: "tool-call", toolCallId: "srvtoolu_1", toolName: "web_search", input: { query: "bun" }, providerExecuted: true };
const serverResult = { type: "tool-result", toolCallId: "srvtoolu_1", toolName: "web_search", output: { type: "json", value: [] }, providerExecuted: true };
const clientCall = { type: "tool-call", toolCallId: "toolu_1", toolName: "read_url", input: { url: "https://bun.sh" } };
const clientResult = { type: "tool-result", toolCallId: "toolu_1", toolName: "read_url", output: { type: "text", value: "page" } };

const roundTrip = (messages: unknown[]) =>
  parseNativeHistory(serializeNativeHistory(messages as ModelMessage[]))?.messages ?? [];

const shape = (messages: ModelMessage[]) =>
  messages.map((m) => [m.role, Array.isArray(m.content) ? (m.content as { type: string; toolName?: string }[]).map((p) => `${p.type}:${p.toolName ?? ""}`) : "text"]);

describe("server tool calls are kept only with their results", () => {
  it("drops a web_search call whose result never arrived, and keeps the client pair", () => {
    // The owner's stored turn, exactly: the result was in the step that was not kept.
    const saved = roundTrip([
      { role: "assistant", content: [{ type: "reasoning", text: "" }, clientCall, serverCall] },
      { role: "tool", content: [clientResult] },
    ]);
    expect(shape(saved)).toEqual([
      ["assistant", ["reasoning:", "tool-call:read_url"]],
      ["tool", ["tool-result:read_url"]],
    ]);
  });

  it("keeps a web_search call whose result came in the next step", () => {
    const messages = [
      { role: "assistant", content: [serverCall, clientCall] },
      { role: "tool", content: [clientResult] },
      { role: "assistant", content: [serverResult, { type: "text", text: "Bun 1.3" }] },
    ];
    expect(shape(roundTrip(messages))).toEqual(shape(messages as ModelMessage[]));
  });

  it("drops a web_search result whose call is gone", () => {
    const saved = roundTrip([
      { role: "assistant", content: [serverResult, { type: "text", text: "Bun 1.3" }] },
    ]);
    expect(shape(saved)).toEqual([["assistant", ["text:"]]]);
  });

  it("drops a message the repair leaves empty", () => {
    const saved = roundTrip([
      { role: "assistant", content: [{ type: "text", text: "searching" }] },
      { role: "assistant", content: [serverCall] },
    ]);
    expect(shape(saved)).toEqual([["assistant", ["text:"]]]);
  });

  it("repairs an already-broken stored turn when it is read back", () => {
    // Rows saved before this fix: the envelope on disk still has the orphan.
    const onDisk = JSON.stringify({
      v: 1,
      kind: "native-history",
      messages: [
        { role: "assistant", content: [clientCall, serverCall] },
        { role: "tool", content: [clientResult] },
      ],
    });
    expect(shape(parseNativeHistory(onDisk)!.messages)).toEqual([
      ["assistant", ["tool-call:read_url"]],
      ["tool", ["tool-result:read_url"]],
    ]);
  });

  it("is stable: repairing twice gives the same bytes (the prompt cache depends on it)", () => {
    const once = serializeNativeHistory([
      { role: "assistant", content: [clientCall, serverCall] },
      { role: "tool", content: [clientResult] },
    ] as unknown as ModelMessage[]);
    const twice = serializeNativeHistory(parseNativeHistory(once)!.messages);
    expect(twice).toBe(once);
  });

  it("leaves client tool calls alone, paired or not", () => {
    // Client tools are paired by their own code paths; this repair is only for
    // the provider's server tools, whose result arrives on the provider's schedule.
    const messages = [{ role: "assistant", content: [clientCall] }];
    expect(shape(roundTrip(messages))).toEqual(shape(messages as ModelMessage[]));
  });
});
