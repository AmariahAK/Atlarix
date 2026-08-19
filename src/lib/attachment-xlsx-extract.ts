/**
 * Spreadsheet (.xlsx) attachment extraction.
 *
 * Sits here with the other `attachment-*-extract` modules (pptx, odt, rtf, csv)
 * rather than inline in `lib/tools/workspace.ts`, where it used to live — the tool
 * module registers tools on import, so extraction could not be unit-tested without
 * dragging the whole registry in.
 *
 * Parsed with `read-excel-file`, which replaced the `xlsx` (SheetJS) package:
 * that one is abandoned on npm at 0.18.5 with an unfixable prototype-pollution and
 * ReDoS advisory, and this code path parses attacker-supplied files — a
 * spreadsheet arrives as a user attachment or as a workspace file the agent reads.
 *
 * Read-only by design, which is all this ever needed. Legacy `.xls` (BIFF) is not
 * supported and was not supported before either: `workspace.ts` already answers
 * that format with "re-save it as .xlsx and re-attach".
 */
import log from "electron-log";
import {
  matrixToTable,
  matrixToCsv,
  cellToString,
  type CsvTableData,
} from "./attachment-csv-extract";

const logger = log.scope("attachment-xlsx");

export type XlsxExtractResult = {
  text: string;
  sheets: number;
  rows: number;
  success: boolean;
  table: CsvTableData | null;
  sheetName?: string;
};

export async function extractTextFromXlsx(
  buffer: Buffer,
): Promise<XlsxExtractResult> {
  try {
    // `read-excel-file/node` takes a Buffer and returns EVERY sheet as
    // `{ sheet, data: Row[] }` — the exact shape this function used to assemble
    // by hand from SheetJS's `sheet_to_csv` plus `decode_range`.
    const { default: readXlsxFile } = await import("read-excel-file/node");
    const sheets = await readXlsxFile(buffer);

    let allText = "";
    let totalRows = 0;
    for (const { sheet, data } of sheets) {
      const matrix = data.map((row) => row.map(cellToString));
      allText += `[Sheet: ${sheet}]\n${matrixToCsv(matrix)}\n\n`;
      totalRows += matrix.length;
    }

    // Structured table from the first sheet for the renderer card — shared with
    // the CSV path instead of re-implementing the same row/column caps twice.
    const first = sheets[0];
    const table = first
      ? matrixToTable(first.data.map((row) => row.map(cellToString)))
      : null;

    return {
      text: allText.trim(),
      sheets: sheets.length,
      rows: totalRows,
      success: Boolean(allText.trim().length > 0),
      table,
      sheetName: first?.sheet,
    };
  } catch (err) {
    logger.warn(`xlsx failed: ${err}`);
    return { text: "", sheets: 0, rows: 0, success: false, table: null };
  }
}
