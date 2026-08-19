import { cleanFullResponse } from "@/ipc/utils/cleanFullResponse";
import { describe, it, expect } from "vitest";

describe("cleanFullResponse", () => {
  it("should replace < characters in atlarix-write attributes", () => {
    const input = `<atlarix-write path="src/file.tsx" description="Testing <a> tags.">content</atlarix-write>`;
    const expected = `<atlarix-write path="src/file.tsx" description="Testing ＜a＞ tags.">content</atlarix-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should replace < characters in multiple attributes", () => {
    const input = `<atlarix-write path="src/<component>.tsx" description="Testing <div> tags.">content</atlarix-write>`;
    const expected = `<atlarix-write path="src/＜component＞.tsx" description="Testing ＜div＞ tags.">content</atlarix-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle multiple nested HTML tags in a single attribute", () => {
    const input = `<atlarix-write path="src/file.tsx" description="Testing <div> and <span> and <a> tags.">content</atlarix-write>`;
    const expected = `<atlarix-write path="src/file.tsx" description="Testing ＜div＞ and ＜span＞ and ＜a＞ tags.">content</atlarix-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle complex example with mixed content", () => {
    const input = `
      BEFORE TAG
  <atlarix-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use <a> tags.">
import React from 'react';
</atlarix-write>
AFTER TAG
    `;

    const expected = `
      BEFORE TAG
  <atlarix-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use ＜a＞ tags.">
import React from 'react';
</atlarix-write>
AFTER TAG
    `;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle other atlarix tag types", () => {
    const input = `<atlarix-rename from="src/<old>.tsx" to="src/<new>.tsx"></atlarix-rename>`;
    const expected = `<atlarix-rename from="src/＜old＞.tsx" to="src/＜new＞.tsx"></atlarix-rename>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle atlarix-delete tags", () => {
    const input = `<atlarix-delete path="src/<component>.tsx"></atlarix-delete>`;
    const expected = `<atlarix-delete path="src/＜component＞.tsx"></atlarix-delete>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should not affect content outside atlarix tags", () => {
    const input = `Some text with <regular> HTML tags. <atlarix-write path="test.tsx" description="With <nested> tags.">content</atlarix-write> More <html> here.`;
    const expected = `Some text with <regular> HTML tags. <atlarix-write path="test.tsx" description="With ＜nested＞ tags.">content</atlarix-write> More <html> here.`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle empty attributes", () => {
    const input = `<atlarix-write path="src/file.tsx">content</atlarix-write>`;
    const expected = `<atlarix-write path="src/file.tsx">content</atlarix-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle attributes without < characters", () => {
    const input = `<atlarix-write path="src/file.tsx" description="Normal description">content</atlarix-write>`;
    const expected = `<atlarix-write path="src/file.tsx" description="Normal description">content</atlarix-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("deduplicates repeated answer after short think close", () => {
    const open = "<" + "think" + ">";
    const close = "</" + "think" + ">";
    const half = "x".repeat(55);
    const dup = half + half;
    const input = `${open}thoughts${close}${dup}`;
    const expected = `${open}thoughts${close}${half}`;
    expect(cleanFullResponse(input)).toBe(expected);
  });

  it("deduplicates repeated answer after long-form think close", () => {
    const open = "<" + "redacted_thinking" + ">";
    const close = "</" + "redacted_thinking" + ">";
    const half = "y".repeat(55);
    const dup = half + half;
    const input = `${open}x${close}${dup}`;
    const expected = `${open}x${close}${half}`;
    expect(cleanFullResponse(input)).toBe(expected);
  });
});

