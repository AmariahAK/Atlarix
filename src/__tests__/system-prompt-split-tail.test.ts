/**
 * Build mode sent this turn's request (`<user_context>`) inside the one system
 * block that carries the prompt-cache breakpoint, so every turn missed the
 * cache and wrote ~20k tokens again (QA, measured on Anthropic). The build
 * round now takes the tail back out into its own system message.
 */
import { describe, expect, it } from "vitest";
import { joinSystemPromptParts, splitDynamicTail } from "@/prompts/system_prompt";

const parts = { stableHeader: "# Identity\nYou are Atlarix.", dynamicTail: "# Current date\nToday.\n\n<user_context>\nfix the bug\n</user_context>" };

describe("splitDynamicTail", () => {
  it("takes the tail out of a finished prompt, keeping what was added around it", () => {
    const full = `[Active Skill]\n\n${joinSystemPromptParts(parts)}\n\n# Guides\n- one`;
    const r = splitDynamicTail(full, parts.dynamicTail);
    expect(r).toEqual({
      systemPromptOverride: "[Active Skill]\n\n# Identity\nYou are Atlarix.\n\n# Guides\n- one",
      dynamicSystemTail: parts.dynamicTail,
    });
  });

  it("two turns with different requests give the same cached part", () => {
    const turn = (ask: string) => {
      const p = { ...parts, dynamicTail: parts.dynamicTail.replace("fix the bug", ask) };
      return splitDynamicTail(`${joinSystemPromptParts(p)}\n\n# Guides`, p.dynamicTail);
    };
    const a = turn("say hi") as { systemPromptOverride: string };
    const b = turn("read notes.txt") as { systemPromptOverride: string };
    expect(a.systemPromptOverride).toBe(b.systemPromptOverride);
    expect(a.systemPromptOverride).not.toContain("user_context");
  });

  it("leaves a prompt without the joined tail alone (the summarize prompt)", () => {
    expect(splitDynamicTail("Summarize this chat.", parts.dynamicTail)).toBe("Summarize this chat.");
    expect(splitDynamicTail("x", undefined)).toBe("x");
  });
});
