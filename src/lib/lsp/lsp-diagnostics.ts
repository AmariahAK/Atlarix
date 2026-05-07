import * as path from "path";
import { getActiveClients, type LspClient } from "./lsp-client";
import type { Diagnostic } from "vscode-languageserver-types";

export { getActiveClients };

export interface FormattedDiag {
  file: string;
  line: number;
  severity: number;
  message: string;
}

export function formatDiagnosticsForContext(clients: LspClient[]): string {
  const allDiags: FormattedDiag[] = [];

  for (const client of clients) {
    for (const [file, diags] of client.pushDiagnostics) {
      for (const d of diags) {
        allDiags.push({
          file: path.basename(file),
          line: (d.range?.start?.line ?? 0) + 1,
          severity: d.severity ?? 2,
          message: d.message ?? "",
        });
      }
    }
  }

  if (allDiags.length === 0) return "";

  allDiags.sort((a, b) => a.severity - b.severity);

  const limited = allDiags.slice(0, 20);
  const errors = limited.filter((d) => d.severity === 1);
  const warnings = limited.filter((d) => d.severity === 2);

  const lines: string[] = [];

  lines.push(`## Live Diagnostics (${errors.length} errors, ${warnings.length} warnings)`);

  if (errors.length > 0) {
    lines.push("### Errors");
    for (const e of errors) {
      lines.push(`- ${e.file}:${e.line} — ${e.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push("### Warnings");
    for (const w of warnings) {
      lines.push(`- ${w.file}:${w.line} — ${w.message}`);
    }
  }

  return lines.join("\n");
}

export function getDiagnosticsForFile(
  clients: LspClient[],
  filePath: string
): Diagnostic[] {
  const diags: Diagnostic[] = [];

  for (const client of clients) {
    const fileDiags = client.pushDiagnostics.get(filePath);
    if (fileDiags) {
      diags.push(...fileDiags);
    }
  }

  return diags;
}

export function getErrorCount(clients: LspClient[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;

  for (const client of clients) {
    for (const [, diags] of client.pushDiagnostics) {
      for (const d of diags) {
        if (d.severity === 1) errors++;
        else if (d.severity === 2) warnings++;
      }
    }
  }

  return { errors, warnings };
}