import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractCsvFromBuffer } from "@/lib/attachment-csv-extract";
import {
  extractTextFromPptxBuffer,
  extractTextFromOdtBuffer,
} from "@/lib/attachment-office-xml-extract";
import { extractTextFromRtfBuffer } from "@/lib/attachment-rtf-extract";
import { buildToolExpandView } from "@/lib/chat/tool-expand-view";

describe("attachment readers (v11)", () => {
  it("extracts structured CSV with headers and rows", async () => {
    const csv = Buffer.from("name,age,city\nAda,36,London\nGrace,45,Arlington\n");
    const result = await extractCsvFromBuffer(csv);
    expect(result.success).toBe(true);
    expect(result.table?.headers).toEqual(["name", "age", "city"]);
    expect(result.table?.rows).toEqual([
      ["Ada", "36", "London"],
      ["Grace", "45", "Arlington"],
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.columnCount).toBe(3);
    expect(result.text).toContain("Ada");
  });

  it("fails gracefully on empty CSV", async () => {
    const result = await extractCsvFromBuffer(Buffer.from(""));
    expect(result.success).toBe(false);
    expect(result.table).toBeNull();
  });

  it("extracts slide text from a minimal pptx", () => {
    const slide = (text: string) =>
      `<?xml version="1.0"?><p:sld xmlns:a="urn:a"><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sld>`;
    const zipped = zipSync({
      "[Content_Types].xml": strToU8("<?xml version=\"1.0\"?><Types/>"),
      "ppt/slides/slide1.xml": strToU8(slide("Hello from slide one")),
      "ppt/slides/slide2.xml": strToU8(slide("Second slide & more")),
    });
    const result = extractTextFromPptxBuffer(Buffer.from(zipped));
    expect(result.success).toBe(true);
    expect(result.parts).toBe(2);
    expect(result.text).toContain("[Slide 1]");
    expect(result.text).toContain("Hello from slide one");
    expect(result.text).toContain("Second slide & more");
  });

  it("extracts text from a minimal odt", () => {
    const contentXml =
      '<?xml version="1.0"?><office:document-content><office:body><office:text>' +
      "<text:p>First paragraph</text:p><text:p>Second &amp; final</text:p>" +
      "</office:text></office:body></office:document-content>";
    const zipped = zipSync({
      mimetype: strToU8("application/vnd.oasis.opendocument.text"),
      "content.xml": strToU8(contentXml),
    });
    const result = extractTextFromOdtBuffer(Buffer.from(zipped));
    expect(result.success).toBe(true);
    expect(result.text).toContain("First paragraph");
    expect(result.text).toContain("Second & final");
  });

  it("returns failure for non-zip pptx/odt buffers", () => {
    expect(extractTextFromPptxBuffer(Buffer.from("not a zip")).success).toBe(false);
    expect(extractTextFromOdtBuffer(Buffer.from("not a zip")).success).toBe(false);
  });

  it("strips RTF control words and decodes escapes", () => {
    // NB: the single space after a control word is an RTF delimiter (not
    // rendered) — `\b bold \b0 world` renders as "bold world".
    const rtf = Buffer.from(
      "{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs24 Hello \\b bold \\b0 world\\par Caf\\'e9 and \\u8212?dash}",
    );
    const result = extractTextFromRtfBuffer(rtf);
    expect(result.success).toBe(true);
    expect(result.text).toContain("Hello bold world");
    expect(result.text).toContain("Café");
    expect(result.text).toContain("—dash");
    expect(result.text).not.toMatch(/\\par|fonttbl|Helvetica/);
  });

  it("rejects non-RTF buffers", () => {
    expect(extractTextFromRtfBuffer(Buffer.from("plain text")).success).toBe(false);
  });

  it("routes read_attachment spreadsheet results to the table card", () => {
    const resultText = JSON.stringify({
      success: true,
      filename: "people.csv",
      type: "spreadsheet",
      table: {
        headers: ["name", "age"],
        rows: [["Ada", "36"]],
        totalRows: 1,
        totalColumns: 2,
        truncated: false,
      },
    });
    const view = buildToolExpandView(
      "read_attachment",
      { id: "att-1" },
      resultText,
      "done" as never,
    );
    expect(view.kind).toBe("table");
    if (view.kind === "table") {
      expect(view.fileName).toBe("people.csv");
      expect(view.headers).toEqual(["name", "age"]);
      expect(view.rows).toEqual([["Ada", "36"]]);
      expect(view.totalRows).toBe(1);
    }
  });

  it("routes read_attachment document text to the snippet card", () => {
    const resultText = JSON.stringify({
      success: true,
      filename: "deck.pptx",
      type: "presentation",
      content: "[Slide 1]\nHello",
      slides: 1,
    });
    const view = buildToolExpandView(
      "read_attachment",
      { id: "att-2" },
      resultText,
      "done" as never,
    );
    expect(view.kind).toBe("read_snippet");
    if (view.kind === "read_snippet") {
      expect(view.snippet).toContain("Hello");
      expect(view.fileName).toBe("deck.pptx");
    }
  });
});
