/**
 * Console / Network hand-off to chat.
 *
 * Both panels used to concatenate their output into the composer at ANY size, so
 * sending a busy tab buried whatever the user was half-way through typing under
 * thousands of lines. Substantial sends now become an attachment chip.
 *
 * The other half of the requirement is that the chip behaves like every other
 * attachment — including while a message is being EDITED. That works because
 * this reuses the existing `textPaste` kind rather than adding a fourth; the
 * round-trip below is what pins it, since a new kind that got registered in only
 * some of its places would render as raw text, which is the bug being fixed.
 */
import { describe, it, expect } from "vitest";

import {
  buildBrowserLogAttachment,
  browserLogDisplayName,
  shouldAttachBrowserLog,
  upsertBrowserLogAttachment,
} from "@/lib/chat/browser-log-attachment";
import { buildPastePromptsFromAttachments } from "@/lib/chat/attachment-tag-blocks";
import { splitAttachmentTagsForEdit } from "@/lib/chat/edit-attachment-tags";
import { isTextPasteAttachment } from "@/lib/chat/text-paste-attachment";

const longLog = Array.from({ length: 40 }, (_, i) => `[log] line ${i}`).join("\n");

describe("shouldAttachBrowserLog", () => {
  /** One console row is smaller than the chip that would represent it. */
  it("leaves a short send inline", () => {
    expect(shouldAttachBrowserLog("[error] boom")).toBe(false);
  });

  it("attaches anything substantial", () => {
    expect(shouldAttachBrowserLog(longLog)).toBe(true);
    expect(shouldAttachBrowserLog("x".repeat(600))).toBe(true);
  });
});

describe("browserLogDisplayName", () => {
  it("names the source, the page and the size", () => {
    expect(browserLogDisplayName("Console", "https://www.youtube.com/watch?v=x", 12)).toBe(
      "Console · youtube.com · 12 entries",
    );
    expect(browserLogDisplayName("Network", "https://github.com", 43)).toBe(
      "Network · github.com · 43 requests",
    );
  });

  it("singularises, and passes a non-URL label through", () => {
    expect(browserLogDisplayName("Console", "all tabs", 1)).toBe(
      "Console · all tabs · 1 entry",
    );
  });
});

describe("upsertBrowserLogAttachment", () => {
  /** Clicking the same card twice should replace its chip, not stack copies. */
  it("replaces a chip from the same page load", () => {
    const first = buildBrowserLogAttachment({
      source: "Console",
      label: "https://github.com",
      count: 2,
      content: "a",
      scopeKey: "1:2",
    });
    const second = buildBrowserLogAttachment({
      source: "Console",
      label: "https://github.com",
      count: 3,
      content: "a\nb",
      scopeKey: "1:2",
    });
    const out = upsertBrowserLogAttachment(
      upsertBrowserLogAttachment([], first),
      second,
    );
    expect(out).toHaveLength(1);
    expect(out[0].textPaste?.content).toBe("a\nb");
  });

  it("keeps two different page loads as separate chips", () => {
    const yt = buildBrowserLogAttachment({
      source: "Console",
      label: "https://youtube.com",
      count: 1,
      content: "yt",
      scopeKey: "1:1",
    });
    const gh = buildBrowserLogAttachment({
      source: "Console",
      label: "https://github.com",
      count: 1,
      content: "gh",
      scopeKey: "1:2",
    });
    expect(upsertBrowserLogAttachment([yt], gh)).toHaveLength(2);
  });

  it("keeps Console and Network apart for the same load", () => {
    const c = buildBrowserLogAttachment({
      source: "Console",
      label: "https://x.dev",
      count: 1,
      content: "c",
      scopeKey: "1:1",
    });
    const n = buildBrowserLogAttachment({
      source: "Network",
      label: "https://x.dev",
      count: 1,
      content: "n",
      scopeKey: "1:1",
    });
    expect(upsertBrowserLogAttachment([c], n)).toHaveLength(2);
  });
});

describe("a browser log is an ordinary attachment", () => {
  const attachment = buildBrowserLogAttachment({
    source: "Network",
    label: "https://github.com",
    count: 43,
    content: longLog,
    scopeKey: "1:2",
  });

  it("is recognised by the existing text-paste predicate", () => {
    expect(isTextPasteAttachment(attachment)).toBe(true);
  });

  it("carries its body to the model and only a stub to the display copy", () => {
    const { modelPrompt, displayPrompt } = buildPastePromptsFromAttachments(
      "what failed here?",
      [attachment],
    );
    expect(modelPrompt).toContain("what failed here?");
    expect(modelPrompt).toContain("[log] line 39");
    expect(modelPrompt).toContain("Network · github.com · 43 requests");
    // The display copy must NOT inline the body, or the chat bubble becomes the
    // wall of text the chip exists to avoid.
    expect(displayPrompt).not.toContain("[log] line 39");
    expect(displayPrompt).toContain("atlarix-text-attachment");
  });

  /**
   * B3: editing a sent message must still show the chip. The edit UI splits the
   * stub tags out of the prose and renders them read-only; a kind it did not
   * recognise would be left in the textarea as literal XML.
   */
  it("survives message editing as a chip rather than raw text", () => {
    const { displayPrompt } = buildPastePromptsFromAttachments("what failed here?", [
      attachment,
    ]);
    const { text, tags } = splitAttachmentTagsForEdit(displayPrompt);
    expect(text).toBe("what failed here?");
    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe("atlarix-text-attachment");
    expect(tags[0].attributes.filename).toBe("Network · github.com · 43 requests");
  });
});
