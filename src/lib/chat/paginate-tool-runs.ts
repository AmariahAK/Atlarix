/**
 * Group consecutive paginate-able tool cards (terminal commands + file
 * writes/edits) into runs so the chat can paginate them in pages of ~6 instead
 * of growing the page unbounded on long turns. Works on either the parsed-parts
 * list or the stream-thread item list via a tool-name accessor.
 */

/** Tool cards that should paginate when many run in a row. */
const PAGINATABLE_TOOLS = new Set(["run_command", "write_file", "edit_file"]);

/** Page size — show this many per run before a "show more" control. */
export const TOOL_PAGE_SIZE = 6;

export function isPaginatableToolName(
  name: string | null | undefined,
): boolean {
  return !!name && PAGINATABLE_TOOLS.has(name);
}

export type PaginatedRun<T> =
  | { type: "single"; item: T }
  | { type: "run"; items: T[] };

/**
 * Collapse maximal runs of CONSECUTIVE paginate-able tool items longer than
 * `TOOL_PAGE_SIZE` into `{ type: "run" }`; everything else (text, thoughts,
 * other tools, or short runs) passes through as `{ type: "single" }`. Order is
 * preserved exactly — only consecutive same-kind tool cards are bundled.
 */
export function groupPaginatableRuns<T>(
  items: T[],
  toolNameOf: (item: T) => string | null | undefined,
): PaginatedRun<T>[] {
  const out: PaginatedRun<T>[] = [];
  let run: T[] = [];

  const flush = () => {
    if (run.length > TOOL_PAGE_SIZE) {
      out.push({ type: "run", items: run });
    } else {
      for (const it of run) out.push({ type: "single", item: it });
    }
    run = [];
  };

  for (const it of items) {
    if (isPaginatableToolName(toolNameOf(it))) {
      run.push(it);
    } else {
      flush();
      out.push({ type: "single", item: it });
    }
  }
  flush();
  return out;
}
