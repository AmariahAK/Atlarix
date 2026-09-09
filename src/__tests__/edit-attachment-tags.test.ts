import { describe, expect, it } from "vitest";
import {
  splitAttachmentTagsForEdit,
  rejoinAttachmentTags,
} from "@/lib/chat/edit-attachment-tags";

/**
 * W5 (v14.8.11): editing a sent message keeps attachment chips — the stub
 * tags are stripped from the editable prose and re-spliced on save.
 */

const TEXT_STUB =
  '<atlarix-text-attachment filename="Pasted text · 34 lines" />';
const TERM_STUB =
  '<atlarix-terminal-attachment label="npm test (1-20)" owner="user" lines="1-20" />';

describe("splitAttachmentTagsForEdit / rejoinAttachmentTags", () => {
  it("round-trips: unedited text + tags reproduce an equivalent message", () => {
    const content = `please fix this\n\n${TEXT_STUB}\n\n${TERM_STUB}`;
    const { text, tags } = splitAttachmentTagsForEdit(content);
    expect(text).toBe("please fix this");
    expect(tags).toHaveLength(2);
    const rejoined = rejoinAttachmentTags(text, tags);
    expect(rejoined).toBe(content);
  });

  it("strips multiple mixed tags and keeps surrounding prose", () => {
    const content = `intro ${TEXT_STUB} middle\n${TERM_STUB}\noutro`;
    const { text, tags } = splitAttachmentTagsForEdit(content);
    expect(text).toContain("intro");
    expect(text).toContain("middle");
    expect(text).toContain("outro");
    expect(text).not.toContain("atlarix-");
    expect(tags.map((t) => t.tag)).toEqual([
      "atlarix-text-attachment",
      "atlarix-terminal-attachment",
    ]);
  });

  it("edited prose gets the original tags appended in order", () => {
    const { tags } = splitAttachmentTagsForEdit(
      `old prose\n\n${TEXT_STUB}\n\n${TERM_STUB}`,
    );
    const rejoined = rejoinAttachmentTags("brand new prose", tags);
    expect(rejoined.startsWith("brand new prose")).toBe(true);
    expect(rejoined.indexOf(TEXT_STUB)).toBeLessThan(
      rejoined.indexOf(TERM_STUB),
    );
  });

  it("tag-only message → empty editable text, tags preserved", () => {
    const { text, tags } = splitAttachmentTagsForEdit(TEXT_STUB);
    expect(text).toBe("");
    expect(tags).toHaveLength(1);
    expect(rejoinAttachmentTags("", tags)).toBe(TEXT_STUB);
  });

  it("message with no tags is untouched", () => {
    const { text, tags } = splitAttachmentTagsForEdit("plain question");
    expect(text).toBe("plain question");
    expect(tags).toEqual([]);
    expect(rejoinAttachmentTags("edited", [])).toBe("edited");
  });

  it("paired (full-bodied) tags are stripped and re-spliced whole", () => {
    const full =
      '<atlarix-text-attachment filename="notes">\nline one\nline two\n</atlarix-text-attachment>';
    const { text, tags } = splitAttachmentTagsForEdit(`check\n\n${full}`);
    expect(text).toBe("check");
    expect(tags[0]!.fullMatch).toBe(full);
    expect(rejoinAttachmentTags(text, tags)).toContain("line one\nline two");
  });

  it("malformed/unclosed tag passes through as prose (never dropped)", () => {
    const content =
      'prefix <atlarix-text-attachment filename="x"> body without close';
    const { text, tags } = splitAttachmentTagsForEdit(content);
    expect(tags).toEqual([]);
    expect(text).toBe(content);
  });
});
