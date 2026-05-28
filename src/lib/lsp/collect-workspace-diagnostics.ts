import * as path from "node:path";
import type { Diagnostic } from "vscode-languageserver-types";
import { DiagnosticSeverity } from "vscode-languageserver-types";
import type { Problem, ProblemReport } from "../../../shared/tsc_types";
import { requestLspDiagnosticsAfterSync } from "./lsp-client";

const MAX_FILES_PER_PASS = 20;

function diagnosticCode(d: Diagnostic): number {
  if (typeof d.code === "number") return d.code;
  if (typeof d.code === "string") {
    const n = parseInt(d.code, 10);
    if (!Number.isNaN(n)) return n;
    return Math.abs(d.code.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % 100000;
  }
  return 0;
}

function mapDiagnostic(
  workspaceRoot: string,
  absPath: string,
  d: Diagnostic,
): Problem {
  const rel = path.relative(workspaceRoot, absPath).split(path.sep).join("/");
  return {
    file: rel,
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    message: d.message,
    code: diagnosticCode(d),
    snippet: "",
  };
}

/** Pull LSP errors for workspace-relative paths (e.g. files written this turn). */
export async function collectLspProblemsForPaths(
  workspaceRoot: string,
  relativePaths: string[],
): Promise<ProblemReport> {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const unique = relativePaths
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => {
      const key = p.split(path.sep).join("/");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_FILES_PER_PASS);

  for (const rel of unique) {
    const abs = path.isAbsolute(rel)
      ? path.normalize(rel)
      : path.join(workspaceRoot, rel);
    try {
      const diags = await requestLspDiagnosticsAfterSync(abs, workspaceRoot);
      for (const d of diags) {
        if (d.severity !== DiagnosticSeverity.Error) continue;
        problems.push(mapDiagnostic(workspaceRoot, abs, d));
      }
    } catch {
      // No LSP for this file type — skip
    }
  }

  return { problems };
}
