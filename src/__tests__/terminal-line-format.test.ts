import { describe, expect, it } from "vitest";
import type { TerminalLine } from "@/atoms/terminalInstancesAtoms";
import {
  commandToolLabel,
  formatLineForCopy,
  formatLineForDisplay,
  formatLineForModel,
  linesToVisibleText,
} from "@/lib/chat/terminal-line-format";
import { terminalPasteDisplayName } from "@/lib/chat/terminal-paste-attachment";

const promptYou: TerminalLine = {
  id: "1",
  prefix: "[You]",
  text: "$ git status",
  kind: "prompt",
};

const outputLine: TerminalLine = {
  id: "2",
  prefix: "[You]",
  text: "clean",
  kind: "output",
};

describe("terminal-line-format", () => {
  it("formatLineForDisplay prefixes only prompts", () => {
    expect(formatLineForDisplay(promptYou)).toBe("[You] $ git status");
    expect(formatLineForDisplay(outputLine)).toBe("clean");
    expect(formatLineForCopy(outputLine)).not.toContain("[You]");
  });

  it("formatLineForModel tags prompts only", () => {
    expect(formatLineForModel(promptYou)).toBe("[You] $ git status");
    expect(formatLineForModel(outputLine)).toBe("clean");
  });

  it("linesToVisibleText omits prefix on stdout", () => {
    const text = linesToVisibleText([promptYou, outputLine]);
    expect(text).toBe("[You] $ git status\nclean");
  });

  it("commandToolLabel uses last pipeline segment", () => {
    expect(commandToolLabel("cd foo && git status")).toBe("git");
    expect(commandToolLabel("python script.py")).toBe("python");
    expect(commandToolLabel("node index.js")).toBe("node");
    expect(commandToolLabel("ls")).toBe("ls");
  });

  it("terminalPasteDisplayName uses command tool not zsh", () => {
    expect(
      terminalPasteDisplayName("user", "Shell 1", 1, 5, "cd x && git status"),
    ).toBe("git (1-5)");
  });
});
