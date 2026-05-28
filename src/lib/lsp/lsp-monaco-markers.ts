import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";

export interface LspDiagnosticPayload {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}

function lspSeverityToMarker(severity?: number): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Info;
  }
}

export function lspDiagnosticsToMarkers(
  diagnostics: LspDiagnosticPayload[],
): editor.IMarkerData[] {
  return diagnostics.map((d) => ({
    severity: lspSeverityToMarker(d.severity),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source,
    code: d.code != null ? String(d.code) : undefined,
  }));
}

export function applyLspMarkersToModel(
  model: editor.ITextModel,
  diagnostics: LspDiagnosticPayload[],
): void {
  monaco.editor.setModelMarkers(model, "atlarix-lsp", lspDiagnosticsToMarkers(diagnostics));
}
