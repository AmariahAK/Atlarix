/**
 * CSV + .xlsx extraction after replacing SheetJS.
 *
 * `xlsx@0.18.5` is abandoned on npm with an unfixable prototype-pollution and
 * ReDoS advisory, and these code paths parse ATTACKER-SUPPLIED files — a
 * spreadsheet arrives as a user attachment or as a workspace file the agent is
 * asked to read. It was replaced by `papaparse` (CSV) and `read-excel-file`
 * (.xlsx), both read-only, both actively maintained.
 *
 * The swap is only safe if behaviour is unchanged, and one trap nearly made it
 * not be: papaparse's delimiter auto-detection is WRONG when `skipEmptyLines` is
 * false. Almost every CSV ends with a newline, that trailing empty row skews the
 * heuristic, and a semicolon- or tab-separated file is then read as ONE column of
 * garbage — silently, with `success: true`. The semicolon and tab cases below are
 * the regression guard for exactly that.
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractCsvFromBuffer } from "@/lib/attachment-csv-extract";
import { extractTextFromXlsx } from "@/lib/attachment-xlsx-extract";

const csvOf = (s: string) => Buffer.from(s, "utf8");

describe("CSV extraction (papaparse)", () => {
  it("detects a SEMICOLON delimiter — the case a trailing newline used to break", async () => {
    const r = await extractCsvFromBuffer(csvOf("name;note\nAda;hello\nGrace;plain\n"));
    expect(r.success).toBe(true);
    expect(r.table?.headers).toEqual(["name", "note"]);
    expect(r.table?.rows).toEqual([
      ["Ada", "hello"],
      ["Grace", "plain"],
    ]);
    // The failure mode was ONE column holding the whole line.
    expect(r.columnCount).toBe(2);
  });

  it("detects a TAB delimiter", async () => {
    const r = await extractCsvFromBuffer(csvOf("a\tb\n1\t2\n"));
    expect(r.table?.headers).toEqual(["a", "b"]);
    expect(r.table?.rows).toEqual([["1", "2"]]);
  });

  it("keeps a quoted field that contains the delimiter", async () => {
    const r = await extractCsvFromBuffer(csvOf('name,note\nAda,"hello, world"\n'));
    expect(r.table?.rows).toEqual([["Ada", "hello, world"]]);
    // And it survives the round trip back out to text, still quoted.
    expect(r.text).toContain('"hello, world"');
  });

  it("strips a UTF-8 BOM instead of welding it onto the first header", async () => {
    const r = await extractCsvFromBuffer(csvOf("﻿name,age\nAda,36\n"));
    expect(r.table?.headers).toEqual(["name", "age"]);
  });

  it("keeps a blank row in the MIDDLE but not the one a trailing newline invents", async () => {
    const r = await extractCsvFromBuffer(csvOf("a,b\n1,2\n\n3,4\n"));
    // header + 3 data rows (one of them blank), and no phantom row at the end.
    expect(r.rowCount).toBe(3);
    expect(r.table?.rows[1]).toEqual([""]);
    expect(r.table?.rows[2]).toEqual(["3", "4"]);
  });

  it("reports failure for empty and whitespace-only input", async () => {
    expect((await extractCsvFromBuffer(csvOf(""))).success).toBe(false);
    expect((await extractCsvFromBuffer(csvOf("   \n \n"))).success).toBe(false);
  });
});

/** Minimal OOXML workbook — inline strings, so no sharedStrings part is needed. */
function buildXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Buffer {
  const esc = (v: unknown) =>
    String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cell = (ref: string, v: string | number) =>
    typeof v === "number"
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
  const sheetXml = (rows: (string | number)[][]) =>
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    rows
      .map(
        (cells, r) =>
          `<row r="${r + 1}">` +
          cells.map((v, c) => cell(String.fromCharCode(65 + c) + (r + 1), v)).join("") +
          `</row>`,
      )
      .join("") +
    `</sheetData></worksheet>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join("") +
        `</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets
          .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("") +
        `</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        `</Relationships>`,
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows));
  });
  return Buffer.from(zipSync(files));
}

describe("xlsx extraction (read-excel-file)", () => {
  it("reads EVERY sheet, labelled, not just the first", async () => {
    const buf = buildXlsx([
      { name: "People", rows: [["Name", "Age"], ["Ada", 36]] },
      { name: "Meta", rows: [["k", "v"], ["x", 1]] },
    ]);
    const r = await extractTextFromXlsx(buf);
    expect(r.success).toBe(true);
    expect(r.sheets).toBe(2);
    expect(r.text).toContain("[Sheet: People]");
    expect(r.text).toContain("[Sheet: Meta]");
    expect(r.sheetName).toBe("People");
    expect(r.rows).toBe(4); // 2 rows per sheet
  });

  it("builds the renderer table from the FIRST sheet", async () => {
    const buf = buildXlsx([
      { name: "People", rows: [["Name", "Age"], ["Ada", 36], ["Grace", 45]] },
    ]);
    const r = await extractTextFromXlsx(buf);
    expect(r.table?.headers).toEqual(["Name", "Age"]);
    expect(r.table?.rows).toEqual([
      ["Ada", "36"],
      ["Grace", "45"],
    ]);
    expect(r.table?.totalRows).toBe(2);
  });

  it("quotes a cell containing a comma when serialising to text", async () => {
    const buf = buildXlsx([{ name: "S", rows: [["Name"], ["Ada, Lovelace"]] }]);
    const r = await extractTextFromXlsx(buf);
    expect(r.text).toContain('"Ada, Lovelace"');
  });

  it("fails gracefully on something that is not a workbook", async () => {
    const r = await extractTextFromXlsx(Buffer.from("not a zip at all"));
    expect(r.success).toBe(false);
    expect(r.table).toBeNull();
    expect(r.sheets).toBe(0);
  });
});
