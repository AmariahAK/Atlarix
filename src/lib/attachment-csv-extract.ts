/**
 * CSV attachment extraction — structured table + plain text.
 * Parses via the bundled `xlsx` package (same engine as Excel attachments) so
 * delimiter sniffing, quoting, and BOM handling stay consistent — no extra dep.
 */

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

export async function extractCsvFromBuffer(buffer: Buffer): Promise<CsvExtractResult> {
  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(buffer, { type: "buffer", raw: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) {
      return { text: "", table: null, rowCount: 0, columnCount: 0, success: false };
    }

    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown as string[][];

    const totalRows = matrix.length;
    const totalColumns = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    if (totalRows === 0) {
      return { text: "", table: null, rowCount: 0, columnCount: 0, success: false };
    }

    const headers = (matrix[0] ?? []).slice(0, MAX_TABLE_COLUMNS).map(String);
    const rows = matrix
      .slice(1, 1 + MAX_TABLE_ROWS)
      .map((r) => r.slice(0, MAX_TABLE_COLUMNS).map(String));
    const truncated =
      totalRows - 1 > MAX_TABLE_ROWS || totalColumns > MAX_TABLE_COLUMNS;

    // W3 (v14.8.11): full CSV text — read_attachment pages it; the renderer
    // table keeps its own row/column caps.
    const text = XLSX.utils.sheet_to_csv(sheet);
    if (!text.trim()) {
      // Whitespace-only input parses to a phantom empty row — treat as failure.
      return { text: "", table: null, rowCount: 0, columnCount: 0, success: false };
    }

    return {
      text,
      table: { headers, rows, totalRows: totalRows - 1, totalColumns, truncated },
      rowCount: totalRows - 1,
      columnCount: totalColumns,
      success: true,
    };
  } catch {
    return { text: "", table: null, rowCount: 0, columnCount: 0, success: false };
  }
}
