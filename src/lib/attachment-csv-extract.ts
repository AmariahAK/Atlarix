/**
 * CSV attachment extraction — structured table + plain text.
 *
 * Parsed with `papaparse`. This used to go through the `xlsx` (SheetJS) package,
 * using a spreadsheet engine as a CSV parser so that delimiter sniffing, quoting
 * and BOM handling stayed consistent with the Excel path. That package is
 * abandoned on npm at 0.18.5 with an unfixable prototype-pollution and ReDoS
 * advisory, and it parses attacker-supplied files, so it was replaced —
 * `papaparse` here, `read-excel-file` for real spreadsheets.
 *
 * The two paths now share `matrixToTable` / `matrixToCsv` below, which they
 * previously duplicated almost line for line.
 */
import Papa from "papaparse";

/** Rows kept in the structured `table` for the tool card; full text still capped separately. */
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMNS = 50;

export type CsvTableData = {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
};

export type CsvExtractResult = {
  text: string;
  table: CsvTableData | null;
  rowCount: number;
  columnCount: number;
  success: boolean;
};

/**
 * A single cell as display text. `read-excel-file` returns real types (number,
 * boolean, Date) and `null` for an empty cell, where SheetJS was asked for
 * strings with `defval: ""` — so the normalisation that used to be the
 * spreadsheet library's job happens here instead, for both paths.
 */
export function cellToString(value: unknown): string {
  if (value == null) return "";
  // ISO, not `String(date)`: this text goes to a model, and
  // "Sat Jan 01 1843 00:00:00 GMT+0027" is neither sortable nor parseable.
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * The capped, renderer-facing table. Shared by the CSV and spreadsheet paths,
 * which built this identically in two places.
 *
 * Returns null for an empty matrix so callers keep one "nothing usable" branch.
 */
export function matrixToTable(matrix: string[][]): CsvTableData | null {
  const totalRows = matrix.length;
  if (totalRows === 0) return null;
  const totalColumns = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    headers: (matrix[0] ?? []).slice(0, MAX_TABLE_COLUMNS).map(cellToString),
    rows: matrix
      .slice(1, 1 + MAX_TABLE_ROWS)
      .map((r) => r.slice(0, MAX_TABLE_COLUMNS).map(cellToString)),
    totalRows: totalRows - 1,
    totalColumns,
    truncated:
      totalRows - 1 > MAX_TABLE_ROWS || totalColumns > MAX_TABLE_COLUMNS,
  };
}

/**
 * Serialise back to CSV — the replacement for SheetJS's `sheet_to_csv`, used for
 * the full text that `read_attachment` pages. `Papa.unparse` applies the quoting
 * rules, so a cell containing a comma, quote or newline survives the round trip.
 */
export function matrixToCsv(matrix: string[][]): string {
  if (matrix.length === 0) return "";
  return Papa.unparse(
    matrix.map((row) => row.map(cellToString)),
    // `\n`, not papaparse's default `\r\n`: SheetJS's `sheet_to_csv` emitted LF,
    // and this text is paged by `read_attachment` and fed to a model, where stray
    // CRs are noise that costs tokens and shows up in quoted excerpts.
    { newline: "\n" },
  );
}

/**
 * True when nothing in the matrix carries content. Checked on the MATRIX rather
 * than on the serialised text, because `Papa.unparse` QUOTES a cell with leading
 * or trailing whitespace — so a file of only spaces serialises to `"   "`, whose
 * `.trim()` is non-empty, and a text-based check silently passes it as real
 * content. SheetJS emitted the same cell unquoted, which is why the old
 * text-based check worked and this one had to change with the library.
 */
function isBlankMatrix(matrix: string[][]): boolean {
  return matrix.every((row) => row.every((cell) => cell.trim() === ""));
}

/**
 * Parse CSV text into a matrix, preserving the previous behaviour exactly.
 *
 * TWO PASSES, and the reason is a real trap: papaparse's delimiter
 * auto-detection is WRONG when `skipEmptyLines` is false. A trailing newline —
 * which nearly every CSV file ends with — leaves a final empty row that skews the
 * heuristic, and a semicolon- or tab-separated file is then detected as
 * comma-separated and parsed as ONE column. Verified against `;`, `\t` and `|`
 * files: detection is correct with `skipEmptyLines: true` and wrong without it.
 *
 * But `true` also drops blank rows INSIDE the file, which SheetJS preserved (as
 * `["", ""]`). So: detect with the flag on, then re-parse with the detected
 * delimiter and the flag off, and trim only the trailing blank the newline
 * created. Blank rows in the middle survive, as before.
 */
function parseCsvText(text: string): string[][] {
  const detect = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: true,
  });
  const delimiter = detect.meta?.delimiter || ",";

  const full = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: false,
    delimiter,
  });
  const rows = (full.data ?? []).map((r) =>
    Array.isArray(r) ? r.map(cellToString) : [],
  );
  // Drop ONLY a trailing all-empty row (the artefact of the final newline).
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === "")) {
    rows.pop();
  }
  return rows;
}

export async function extractCsvFromBuffer(
  buffer: Buffer,
): Promise<CsvExtractResult> {
  const empty: CsvExtractResult = {
    text: "",
    table: null,
    rowCount: 0,
    columnCount: 0,
    success: false,
  };
  try {
    // Strip a UTF-8 BOM: SheetJS absorbed it, and left in place it becomes part
    // of the first header cell, so a lookup by column name silently misses.
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    const matrix = parseCsvText(text);
    // Whitespace-only input parses to rows of blank cells — treat as failure, as
    // the SheetJS path did.
    if (isBlankMatrix(matrix)) return empty;
    const table = matrixToTable(matrix);
    if (!table) return empty;

    // W3 (v14.8.11): full CSV text — read_attachment pages it; the renderer
    // table keeps its own row/column caps.
    const csv = matrixToCsv(matrix);

    return {
      text: csv,
      table,
      rowCount: table.totalRows,
      columnCount: table.totalColumns,
      success: true,
    };
  } catch {
    return empty;
  }
}
