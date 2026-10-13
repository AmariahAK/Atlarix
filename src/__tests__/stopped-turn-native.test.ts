/**
 * A stopped turn keeps what finished (QA #33): the model was told nothing ran
 * after eight reads had completed.
 */
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { stoppedTurnNative } from "@/lib/ai/native-history";

const call = (id: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: `${id}.ts` } }] });
const result = (id: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value: "ok" } }] });

describe("what a stopped turn leaves for the next one", () => {
  it("keeps finished steps from earlier rounds and the running one, once each, then says it was stopped", () => {
    const out = stoppedTurnNative([call("a"), result("a")], [call("a"), result("a"), call("b"), result("b")], "[stopped]")!;
    const ids = out.flatMap((m) => (Array.isArray(m.content) ? m.content.map((p) => `${p.type}:${(p as { toolCallId: string }).toolCallId}`) : [m.content]));
    expect(ids).toEqual(["tool-call:a", "tool-result:a", "tool-call:b", "tool-result:b", "[stopped]"]);
  });

  it("drops a call whose result never came (providers reject a lone tool_use)", () => {
    const out = stoppedTurnNative([], [call("a"), result("a"), call("b")], "[stopped]")!;
    expect(JSON.stringify(out)).not.toContain('"b"');
    expect(out.at(-1)).toEqual({ role: "assistant", content: "[stopped]" });
  });

  it("is null when nothing finished", () => {
    expect(stoppedTurnNative([], [call("a")], "[stopped]")).toBeNull();
  });
});
