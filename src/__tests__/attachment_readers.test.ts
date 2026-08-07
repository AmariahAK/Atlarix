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

// ── W3 (v14.8.11): read_attachment paging over the full extraction ──
import { ToolRegistry } from "@/lib/tools";
import { AttachmentStore } from "@/lib/attachment-store";

describe("read_attachment paging (W3)", () => {
  const bigText = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");

  const addTextAttachment = (id: string, text: string) => {
    AttachmentStore.add({
      id,
      filename: `${id}.txt`,
      mimeType: "text/plain",
      data: Buffer.from(text, "utf-8").toString("base64"),
      size: text.length,
      addedAt: 1,
    });
  };

  it("first page defaults to 2000 lines with an exact next-call pointer", async () => {
    addTextAttachment("page-a", bigText);
    const env: any = await ToolRegistry.execute("read_attachment", {
      attachmentId: "page-a",
    });
    expect(env.success).toBe(true);
    const r = env.result;
    expect(r.startLine).toBe(1);
    expect(r.endLine).toBe(2000);
    expect(r.totalLines).toBe(5000);
    expect(r.hasMore).toBe(true);
    expect(r.content).toContain("line 1\n");
    expect(r.content).not.toContain("line 2001");
    expect(r.note).toContain('"offset": 2001');
  });

  it("middle and last pages honor offset; past-end is a clean empty page", async () => {
    addTextAttachment("page-b", bigText);
    const mid: any = (
      (await ToolRegistry.execute("read_attachment", {
        attachmentId: "page-b",
        offset: 2001,
        limit: 1000,
      })) as any
    ).result;
    expect(mid.startLine).toBe(2001);
    expect(mid.endLine).toBe(3000);
    expect(mid.content.startsWith("line 2001")).toBe(true);
    expect(mid.hasMore).toBe(true);

    const last: any = (
      (await ToolRegistry.execute("read_attachment", {
        attachmentId: "page-b",
        offset: 4001,
      })) as any
    ).result;
    expect(last.endLine).toBe(5000);
    expect(last.hasMore).toBeFalsy();
    expect(last.note).toContain("end of content");

    const past: any = (
      (await ToolRegistry.execute("read_attachment", {
        attachmentId: "page-b",
        offset: 99999,
      })) as any
    ).result;
    expect(past.success).toBe(true);
    expect(past.content).toBe("");
    expect(past.note).toContain("end of content");
  });

  it("small files return whole content with no paging noise", async () => {
    addTextAttachment("page-c", "just\ntwo lines");
    const r: any = (
      (await ToolRegistry.execute("read_attachment", {
        attachmentId: "page-c",
      })) as any
    ).result;
    expect(r.success).toBe(true);
    expect(r.content).toBe("just\ntwo lines");
    expect(r.hasMore).toBeFalsy();
  });

  it("extraction is cached — second page reuses extractCache", async () => {
    addTextAttachment("page-d", bigText);
    await ToolRegistry.execute("read_attachment", { attachmentId: "page-d" });
    const rec = AttachmentStore.get("page-d");
    expect(rec?.extractCache).toBeTruthy();
    const cachedContent = (rec!.extractCache as { content: string }).content;
    expect(cachedContent).toContain("line 5000"); // FULL text cached, not the page
    const again: any = (
      (await ToolRegistry.execute("read_attachment", {
        attachmentId: "page-d",
        offset: 4999,
      })) as any
    ).result;
    expect(again.content).toContain("line 5000");
  });
});

// ── read_attachment classifies by CONTENT, not by extension ──
//
// These are the end-to-end proof of the fix. Each filename below was previously
// unreadable: `read_attachment` gated on a 39-entry extension allowlist, so anything
// absent from it fell all the way through to `type: "binary"` with raw base64 —
// useless to the model. The `.ts` case is the originally reported bug (macOS reports
// `.ts` as video/mp2t).
describe("read_attachment content classification", () => {
  const add = (id: string, filename: string, body: string | Buffer, mimeType = "text/plain") => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf-8");
    AttachmentStore.add({
      id,
      filename,
      mimeType,
      data: buf.toString("base64"),
      size: buf.length,
      addedAt: 1,
    });
  };

  const read = async (id: string) =>
    ((await ToolRegistry.execute("read_attachment", { attachmentId: id })) as any).result;

  it.each([
    ["typescript", "main.ts", "export const x: number = 1;\n"],
    ["esm config", "vite.config.mts", "export default { build: {} }\n"],
    ["vue", "App.vue", "<script setup>\nconst a = 1\n</script>\n"],
    ["powershell", "deploy.ps1", "$ErrorActionPreference = 'Stop'\n"],
    ["terraform", "main.tf", 'resource "aws_s3_bucket" "b" {}\n'],
    ["no extension at all", "Dockerfile", "FROM node:24\nRUN npm ci\n"],
    ["makefile", "Makefile", "all:\n\tgcc -o out main.c\n"],
  ])("reads %s as text", async (_label, filename, body) => {
    const id = `cls-${filename}`;
    add(id, filename, body);
    const r = await read(id);
    expect(r.type).toBe("text");
    expect(r.content).toContain(body.trim().split("\n")[0]);
  });

  it("still returns real binary content as binary", async () => {
    // A NUL-containing blob must NOT be coaxed into the text path.
    add("cls-bin", "blob.dat", Buffer.from([1, 2, 0, 3, 4, 5]), "application/octet-stream");
    const r = await read("cls-bin");
    expect(r.type).toBe("binary");
  });

  it("returns SVG as text markup, not as image input", async () => {
    // Providers reject image/svg+xml as image input; the source is what's useful.
    add("cls-svg", "icon.svg", '<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
    const r = await read("cls-svg");
    expect(r.type).toBe("text");
    expect(r.content).toContain("<svg");
  });

  it("still routes a real PNG to the image path (signature beats text heuristics)", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 7),
    ]);
    add("cls-png", "shot.png", png, "image/png");
    const r = await read("cls-png");
    expect(r.mimeType).toBe("image/png");
  });
});
