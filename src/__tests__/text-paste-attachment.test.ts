import { describe, expect, it } from "vitest";
import {
  buildPromptWithTextPastes,
  formatPasteMetadata,
  shouldCaptureAsTextPaste,
  textPasteDisplayName,
} from "@/lib/chat/text-paste-attachment";

describe("text-paste-attachment", () => {
  it("formats display name with line count", () => {
    expect(textPasteDisplayName("a\nb\nc")).toBe("Pasted text · 3 lines");
  });

  it("shouldCaptureAsTextPaste uses char and line thresholds", () => {
    expect(shouldCaptureAsTextPaste("short")).toBe(false);
    expect(shouldCaptureAsTextPaste("x".repeat(501))).toBe(true);
    expect(shouldCaptureAsTextPaste(Array(21).fill("line").join("\n"))).toBe(
      true,
    );
  });

  it("formatPasteMetadata includes size and lines", () => {
    expect(formatPasteMetadata("a\nb")).toMatch(/line/);
  });

  it("injects full paste into prompt and strips from file attachments", () => {
    const { prompt, modelPrompt, displayPrompt, fileAttachments } =
      buildPromptWithTextPastes("Hello", [
        {
          type: "chat-context",
          textPaste: {
            content: "long body",
            displayName: "Pasted text · 1 line",
          },
        },
        {
          type: "chat-context",
          file: new File(["x"], "x.txt", { type: "text/plain" }),
        },
      ]);
    expect(prompt).toContain("Hello");
    expect(modelPrompt).toContain("long body");
    expect(displayPrompt).toContain("<atlarix-text-attachment");
    expect(displayPrompt).not.toContain("long body");
    expect(fileAttachments).toHaveLength(1);
    expect(fileAttachments[0]?.file?.name).toBe("x.txt");
  });
});
