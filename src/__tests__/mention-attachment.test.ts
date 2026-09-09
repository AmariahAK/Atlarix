import { describe, expect, it } from "vitest";
import type { FileAttachment } from "@/ipc/ipc_types";
import { buildPastePromptsFromAttachments } from "@/lib/chat/attachment-tag-blocks";
import {
  extractMentions,
  isMentionAttachment,
  mentionToken,
} from "@/lib/chat/mention-attachment";

function mention(kind: "file" | "dir", relpath: string): FileAttachment {
  return {
    type: "chat-context",
    id: `${kind}:${relpath}`,
    mention: {
      kind,
      relpath,
      displayName: kind === "dir" ? `${relpath}/` : relpath,
    },
  };
}

describe("mention attachments", () => {
  it("re-emits @file:/@dir: tokens into BOTH model and display prompts", () => {
    const { modelPrompt, displayPrompt, fileAttachments } =
      buildPastePromptsFromAttachments("explain auth", [
        mention("file", "src/auth/login.ts"),
        mention("dir", "src/api"),
      ]);

    expect(modelPrompt).toContain("@file:src/auth/login.ts");
    expect(modelPrompt).toContain("@dir:src/api");
    // Display prompt keeps the reference visible too.
    expect(displayPrompt).toContain("@file:src/auth/login.ts");
    // Mentions are NOT file uploads — never base64-encoded.
    expect(fileAttachments).toHaveLength(0);
  });

  it("isMentionAttachment + mentionToken match the dispatch format", () => {
    const fileAtt = mention("file", "a/b.ts");
    const dirAtt = mention("dir", "a/b");
    expect(isMentionAttachment(fileAtt)).toBe(true);
    expect(isMentionAttachment({ type: "chat-context" })).toBe(false);
    expect(mentionToken(fileAtt as never)).toBe("@file:a/b.ts");
    expect(mentionToken(dirAtt as never)).toBe("@dir:a/b");
  });
});

// ── extractMentions: display-only split of a SENT message ──
//
// `mentionToken()` re-emits `@file:<relpath>` into the prompt because the server
// needs it for parseContextMentions. Nothing turned it back into a chip, so a
// message composed by picking a file rendered as the raw text `@file:text.txt` — it
// looked like text rather than an attachment, and could not be previewed.
//
// This is DISPLAY-ONLY: message.content keeps its tokens, so editing and re-dispatch
// are unaffected. These tests guard that the split never corrupts the visible text.
describe("extractMentions", () => {
  it("pulls a trailing mention out and leaves the question", () => {
    // The exact shape from the reported screenshot.
    const { text, mentions } = extractMentions(
      "could you tell me what this file is about?\n\n@file:text.txt",
    );
    expect(text).toBe("could you tell me what this file is about?");
    expect(mentions).toEqual([{ kind: "file", relpath: "text.txt" }]);
  });

  it("handles several mentions mid-sentence without mangling the words", () => {
    const { text, mentions } = extractMentions(
      "compare @file:a.ts and @file:b.ts please",
    );
    expect(text).toBe("compare and please");
    expect(mentions).toEqual([
      { kind: "file", relpath: "a.ts" },
      { kind: "file", relpath: "b.ts" },
    ]);
  });

  it("distinguishes a directory mention", () => {
    const { mentions } = extractMentions("look in @dir:src/lib");
    expect(mentions).toEqual([{ kind: "dir", relpath: "src/lib" }]);
  });

  it("does not swallow sentence punctuation into the path", () => {
    // "@file:a.ts." must attach a.ts, not "a.ts." — and the full stop stays in the
    // text, tucked back against the preceding word rather than left floating.
    const { text, mentions } = extractMentions("see @file:a.ts. then stop");
    expect(mentions).toEqual([{ kind: "file", relpath: "a.ts" }]);
    expect(text).toBe("see. then stop");
  });

  it("leaves mentions inside backticks alone — they are being discussed, not used", () => {
    const input = "the token `@file:a.ts` means something";
    const { text, mentions } = extractMentions(input);
    expect(text).toBe(input);
    expect(mentions).toEqual([]);
  });

  it("dedupes a repeated mention but keeps first-seen order", () => {
    const { mentions } = extractMentions(
      "@file:b.ts then @file:a.ts then @file:b.ts",
    );
    expect(mentions).toEqual([
      { kind: "file", relpath: "b.ts" },
      { kind: "file", relpath: "a.ts" },
    ]);
  });

  it("passes ordinary text through untouched", () => {
    for (const s of [
      "no mentions here",
      "email me@example.com",
      "",
      "@ alone",
      "@file:",
    ]) {
      const { text, mentions } = extractMentions(s);
      expect(mentions).toEqual([]);
      expect(text).toBe(s.trim());
    }
  });

  it("keeps paths containing spaces out of scope rather than guessing", () => {
    // A relpath runs to whitespace. "my file.txt" cannot be represented, so only
    // "my" is taken — documented rather than silently half-matched.
    const { mentions } = extractMentions("@file:my file.txt");
    expect(mentions).toEqual([{ kind: "file", relpath: "my" }]);
  });
});
