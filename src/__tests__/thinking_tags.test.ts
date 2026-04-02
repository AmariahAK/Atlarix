import { removeThinkingTags } from "@/ipc/utils/thinking_tags";
import { describe, it, expect } from "vitest";

describe("removeThinkingTags", () => {
  it("strips short think wrapper (stream format)", () => {
    const open = "<" + "think" + ">";
    const close = "</" + "think" + ">";
    const input = `${open}reasoning here${close}Visible answer.`;
    expect(removeThinkingTags(input)).toBe("Visible answer.");
  });

  it("strips long-form redacted_thinking wrapper", () => {
    const open = "<" + "redacted_thinking" + ">";
    const close = "</" + "redacted_thinking" + ">";
    const input = `${open}notes${close}Hello.`;
    expect(removeThinkingTags(input)).toBe("Hello.");
  });
});
