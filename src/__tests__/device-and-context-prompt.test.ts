/**
 * Two facts the system prompt must state, and one it must never state again.
 *
 * 1. THE PLATFORM. `process.platform` appeared nowhere in prompt assembly, on a
 *    product that ships a Windows build and whose agent runs shell commands. The
 *    model was left to infer the OS and shell, which means bash idioms on
 *    PowerShell and POSIX paths on Windows.
 *
 * 2. THE CONTEXT WINDOW. The model was never told how much room it had, so
 *    `compress_context` — described as "when context is filling up" — was called
 *    on intuition. A 1M-window session got summarised at 100K.
 *
 * 3. `target:"preview"` was REMOVED with the Preview pane in v14.15.0 but was
 *    still advertised in the run_command description and, worse, in the recovery
 *    advice shown after a browser call fails — steering a stuck model into a
 *    second invalid call.
 */

import { describe, expect, it } from "vitest";
import { constructSystemPromptParts } from "@/prompts/system_prompt";
import { TOOL_RECOVERY_HINTS } from "@/lib/tools/tool-error-patterns";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools";

function build(contextSize?: number) {
  return constructSystemPromptParts({
    chatMode: "build",
    effectiveWorkMode: "build",
    ...(contextSize != null ? { contextSize } : {}),
  });
}

describe("device block", () => {
  it("names the OS and the shell commands actually run in", () => {
    const { stableHeader } = build();
    expect(stableHeader).toContain("Operating system:");
    // Live values, not a hardcoded platform table: os.type() is whatever this
    // machine reports, so a platform nobody enumerated still reads correctly.
    expect(stableHeader).toContain(`${require("node:os").type()}`);
    expect(stableHeader).toMatch(/Shell commands run through/);
  });

  it("still states the hardware budget", () => {
    // Pre-existing guidance that the platform line must not have displaced.
    expect(build().stableHeader).toMatch(/CPU cores/);
    expect(build().stableHeader).toMatch(/GB RAM/);
  });

  it("lives in the cache-stable header, not the per-turn tail", () => {
    // Machine facts never change mid-session; putting them in the tail would
    // churn the prompt-cache prefix for nothing.
    const { dynamicTail } = build();
    expect(dynamicTail).not.toContain("Operating system:");
  });
});

describe("context budget block", () => {
  it("tells the model its actual window size", () => {
    const { stableHeader } = build(1_000_000);
    expect(stableHeader).toContain("# Context budget");
    expect(stableHeader).toContain("1,000,000 tokens");
  });

  it("reflects a different window rather than a fixed number", () => {
    expect(build(128_000).stableHeader).toContain("128,000 tokens");
  });

  it("tells the model NOT to compact on a hunch", () => {
    // The precise failure: a long thread read as a full one. The prompt keeps the
    // one fact the model cannot know (its window size) plus this correction; the
    // full when-to-call rule lives on compress_context itself — see below.
    const { stableHeader } = build(1_000_000);
    expect(stableHeader).toMatch(/long thread is not a full one/i);
  });

  it("leaves the when-to-call rule on compress_context, not in the prompt", () => {
    // Was stated in BOTH places, word for word. The tool description is the
    // conditional one, so the prompt keeps only the window size + the correction.
    const d = String(ToolRegistry.get("compress_context")!.description);
    expect(d).toMatch(/Do NOT call this because the thread feels long/i);
    expect(d).toMatch(/only after a fill warning/i);
    expect(build(1_000_000).stableHeader).not.toMatch(
      /not call `?compress_context`? on a hunch/i,
    );
  });
});

describe("no dead preview target", () => {
  it("is absent from the assembled prompt", () => {
    const { stableHeader, dynamicTail } = build();
    expect(stableHeader).not.toContain('target:"preview"');
    expect(dynamicTail).not.toContain('target:"preview"');
  });

  it("is absent from browser error-recovery advice", () => {
    // This one mattered most: it is shown AFTER a failure, so a wrong parameter
    // here costs a second wasted call from an already-stuck model.
    for (const [tool, advice] of Object.entries(TOOL_RECOVERY_HINTS)) {
      expect(
        advice.includes('target:"preview"'),
        `${tool} still recommends the removed target:"preview"`,
      ).toBe(false);
    }
  });
});
