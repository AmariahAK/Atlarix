/**
 * Office documents, read with nothing but what the browser ships.
 *
 * The point of these assertions is that the OUTPUT IS USABLE PROSE, not merely
 * that extraction returned something. Three specific ways a naive reader
 * produces plausible-looking rubbish:
 *
 *   - Breaking at every tag, so a sentence with one bold word becomes three
 *     lines and nothing reads as a sentence.
 *   - Extracting an .xlsx sheet without resolving `sharedStrings.xml`, so every
 *     text cell comes back as the integer that indexes it — data that looks
 *     like data and is not.
 *   - Sorting slide10 before slide2, so a deck reads out of order.
 *
 * Each has a test, because each would pass "did it return a string".
 */

import { describe, expect, it } from "vitest";
import {
  archiveFormat,
  extractArchiveText,
  looksLikeZip,
  xmlToText,
} from "./ooxml";
import { DOCX_B64, ODT_B64, PPTX_B64, XLSX_B64, bytesOf } from "./ooxml.fixtures";

describe("xmlToText", () => {
  it("keeps a styled sentence on one line", () => {
    // Word splits a sentence at every formatting change. Breaking on runs makes
    // "Revenue was up 40% year on year" three separate lines.
    const text = xmlToText(
      "<w:p><w:r><w:t>Revenue was </w:t></w:r>" +
        "<w:r><w:t>up 40%</w:t></w:r>" +
        "<w:r><w:t> year on year</w:t></w:r></w:p>",
    );
    expect(text).toBe("Revenue was up 40% year on year");
  });

  it("breaks paragraphs, not runs", () => {
    const text = xmlToText("<w:p><w:t>One</w:t></w:p><w:p><w:t>Two</w:t></w:p>");
    expect(text).toBe("One\nTwo");
  });

  it("decodes entities, including numeric and hex", () => {
    expect(xmlToText("<t>a &amp; b &lt;c&gt; &#65; &#x42;</t>")).toBe(
      "a & b <c> A B",
    );
  });

  it("leaves an unknown entity alone rather than eating it", () => {
    expect(xmlToText("<t>&nosuch; x</t>")).toBe("&nosuch; x");
  });

  it("unwraps CDATA", () => {
    expect(xmlToText("<t><![CDATA[a < b]]></t>")).toBe("a < b");
  });
});

describe("reading a real .docx", () => {
  it("returns the document's prose in order", async () => {
    const out = await extractArchiveText(bytesOf(DOCX_B64));
    expect(out?.format).toBe("docx");
    expect(out?.text).toBe(
      "Quarterly report\n" +
        "Revenue was up 40% year on year & rising.\n" +
        "Region\tTotal",
    );
  });
});

describe("reading a real .xlsx", () => {
  it("resolves shared strings instead of returning their indexes", async () => {
    // THE TEST THAT MATTERS. Without sharedStrings.xml this is "0\t1\n2\t1288"
    // — four numbers that a model would happily do arithmetic on.
    const out = await extractArchiveText(bytesOf(XLSX_B64));
    expect(out?.format).toBe("xlsx");
    expect(out?.text).toBe("Region\tTotal\nEMEA\t1288");
  });
});

describe("reading a real .pptx", () => {
  it("orders slides numerically, not lexically", async () => {
    const out = await extractArchiveText(bytesOf(PPTX_B64));
    expect(out?.format).toBe("pptx");
    // Lexical order puts slide10 second and the deck reads wrong.
    expect(out?.text).toBe("First slide\n\nSecond slide\n\nTenth slide");
  });
});

describe("reading a real .odt", () => {
  it("reads OpenDocument paragraphs", async () => {
    const out = await extractArchiveText(bytesOf(ODT_B64));
    expect(out?.format).toBe("odt");
    expect(out?.text).toBe("Hello from ODT\nSecond line");
  });
});

describe("what it refuses", () => {
  it("says no to something that is not a zip", async () => {
    expect(await extractArchiveText(new TextEncoder().encode("hello"))).toBeNull();
  });

  it("says no to a zip of something else", async () => {
    // A real archive whose entries are not an office format. Truncating the
    // .docx fixture's tail also removes its central directory, so build the
    // case from the format detector directly.
    expect(archiveFormat(["photo.jpg", "notes.txt"])).toBeNull();
  });

  it("does not throw on a truncated archive", async () => {
    const whole = bytesOf(DOCX_B64);
    const half = whole.subarray(0, Math.floor(whole.length / 2));
    await expect(extractArchiveText(half)).resolves.toBeNull();
  });

  it("does not throw on random bytes that start like a zip", async () => {
    const fake = new Uint8Array(200);
    fake.set([0x50, 0x4b, 0x03, 0x04]);
    await expect(extractArchiveText(fake)).resolves.toBeNull();
  });
});

describe("format detection", () => {
  it("names each format from its entries", () => {
    expect(archiveFormat(["word/document.xml"])).toBe("docx");
    expect(archiveFormat(["xl/worksheets/sheet1.xml"])).toBe("xlsx");
    expect(archiveFormat(["ppt/slides/slide1.xml"])).toBe("pptx");
    expect(archiveFormat(["mimetype", "OEBPS/content.opf"])).toBe("epub");
    expect(archiveFormat(["content.xml"])).toBe("odt");
  });

  it("recognises a zip by its first bytes", () => {
    expect(looksLikeZip(bytesOf(DOCX_B64))).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode("PK not really"))).toBe(false);
  });
});
