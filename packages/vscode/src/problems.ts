/**
 * The Problems panel as one piece of context: errors before warnings, the open
 * file's first, at most `limit` lines. Pure, so it is tested without an editor.
 */
export interface FileProblems {
  file: string;
  active: boolean;
  /** severity: VS Code's DiagnosticSeverity (0 error, 1 warning, 2 info, 3 hint). */
  items: Array<{ line: number; column: number; severity: number; message: string; source?: string }>;
}

export function problemsText(files: readonly FileProblems[], limit: number): { label: string; body: string } | null {
  const rows = files.flatMap((f) =>
    f.items
      .filter((d) => d.severity <= 1)
      .map((d) => ({ ...d, file: f.file, active: f.active })),
  );
  if (!rows.length) return null;
  rows.sort((a, b) => Number(b.active) - Number(a.active) || a.severity - b.severity || a.file.localeCompare(b.file) || a.line - b.line);
  const shown = rows.slice(0, limit);
  const errors = rows.filter((r) => r.severity === 0).length;
  const warnings = rows.length - errors;
  const label = `Problems (${[errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")})`;
  const body = shown
    .map((r) => `${r.file}:${r.line}:${r.column} ${r.severity === 0 ? "error" : "warning"}${r.source ? ` [${r.source}]` : ""}: ${r.message.split("\n")[0]}`)
    .join("\n");
  return { label, body: rows.length > shown.length ? `${body}\n… and ${rows.length - shown.length} more` : body };
}
