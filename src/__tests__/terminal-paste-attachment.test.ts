import { describe, expect, it } from "vitest";
import { buildPromptWithTextPastes } from "@/lib/chat/text-paste-attachment";
import {
  terminalPasteDisplayName,
  terminalSelectionLineRange,
  terminalShortLabel,
} from "@/lib/chat/terminal-paste-attachment";

describe("terminal-paste-attachment", () => {
  it("formats short labels for user and agent shells", () => {
    expect(terminalShortLabel("user", "Shell 1")).toBe("zsh");
    expect(terminalShortLabel("agent", "Agent 2: npm test")).toBe("A2");
  });

  it("formats display name with line range", () => {
    expect(terminalPasteDisplayName("user", "Shell 1", 1, 41)).toBe(
      "zsh (1-41)",
    );
    expect(terminalPasteDisplayName("agent", "Agent 1", 3, 3)).toBe("A1 (3)");
  });

  it("computes line range from selection within visible log", () => {
    const lines = [
      { prefix: "[You]", text: "$ ls", kind: "prompt" as const },
      { prefix: "[You]", text: "a", kind: "output" as const },
      { prefix: "[You]", text: "b", kind: "output" as const },
    ];
    expect(terminalSelectionLineRange(lines, "a\nb")).toEqual({
      start: 2,
      end: 3,
    });
  });

  it("injects terminal paste into prompt via buildPromptWithTextPastes", () => {
    const { prompt } = buildPromptWithTextPastes("fix this", [
      {
        type: "chat-context",
        terminalPaste: {
          content: "error output",
          displayName: "zsh (1-5)",
          instanceLabel: "Shell 1",
          owner: "user",
          lineStart: 1,
          lineEnd: 5,
        },
      },
    ]);
    expect(prompt).toContain("<atlarix-terminal-attachment");
    expect(prompt).toContain("error output");
  });
});
