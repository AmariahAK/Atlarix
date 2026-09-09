import { describe, expect, it } from "vitest";
import {
  makeRollingEmitter,
  type SubagentActivityEmit,
} from "@/lib/agents/run-subagent";

/**
 * W8 (v14.8.11): sub-agent reasoning segments ROTATE at tool boundaries so
 * each span between tools is its own item (own id → own first-emit ts) and
 * the renderer's (ts, seq) sort interleaves thought → tool → thought — the
 * old per-round stable id pinned ALL of a round's reasoning to one early
 * timestamp ("thoughts on top, tools below").
 */

function collect() {
  const emitted: SubagentActivityEmit[] = [];
  const rolling = makeRollingEmitter((p) => emitted.push(p), "d1", 0);
  return { emitted, rolling };
}

describe("makeRollingEmitter segment rotation (W8)", () => {
  it("reasoning → rotate (tool) → reasoning yields two distinct thought ids", () => {
    const { emitted, rolling } = collect();
    rolling.pushReasoning("thinking about the file");
    rolling.rotate(); // tool boundary
    rolling.pushReasoning("now applying what I read");
    rolling.finish();

    const ids = [...new Set(emitted.map((e) => (e as { id: string }).id))];
    expect(ids).toEqual(["sub-thought-d1-r0-s0", "sub-thought-d1-r0-s1"]);
  });

  it("rotate force-flushes a short pre-tool span the throttle would drop", () => {
    const { emitted, rolling } = collect();
    rolling.pushReasoning("a"); // first push always flushes (lastEmit=0)
    rolling.pushReasoning("b"); // throttled
    rolling.rotate();
    const seg0 = emitted.filter((e) =>
      (e as { id: string }).id.endsWith("-s0"),
    );
    const last = seg0[seg0.length - 1] as { content: string };
    expect(last.content).toBe("ab"); // nothing lost to the throttle
  });

  it("text segments rotate too, independently of reasoning", () => {
    const { emitted, rolling } = collect();
    rolling.pushText("narration before tool");
    rolling.rotate();
    rolling.pushText("narration after tool");
    rolling.finish();
    const textIds = [
      ...new Set(
        emitted
          .map((e) => (e as { id: string }).id)
          .filter((id) => id.startsWith("sub-text-")),
      ),
    ];
    expect(textIds).toEqual(["sub-text-d1-r0-s0", "sub-text-d1-r0-s1"]);
  });

  it("an empty segment emits nothing on rotate", () => {
    const { emitted, rolling } = collect();
    rolling.rotate();
    rolling.rotate();
    rolling.finish();
    expect(emitted).toHaveLength(0);
  });

  it("buffers do not leak across segments", () => {
    const { emitted, rolling } = collect();
    rolling.pushReasoning("first span");
    rolling.rotate();
    rolling.pushReasoning("second span");
    rolling.finish();
    const seg1 = emitted.filter((e) =>
      (e as { id: string }).id.endsWith("-s1"),
    );
    for (const e of seg1) {
      expect((e as { content: string }).content).not.toContain("first span");
    }
  });
});
