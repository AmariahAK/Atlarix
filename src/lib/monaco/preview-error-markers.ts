/**
 * Map preview / dev-server ParsedErrors to Monaco markers (VS Code–style squiggles).
 */

import type { editor } from "monaco-editor";
import * as monaco from "monaco-editor";
import type { ParsedError } from "@/lib/devServerErrorParser";
import { previewErrorMatchesFile } from "@/lib/monaco/preview-error-paths";

export { cleanPreviewErrorFilePath, previewErrorMatchesFile } from "@/lib/monaco/preview-error-paths";

export function previewErrorsToMarkers(
  errors: ParsedError[],
  editorFilePath: string,
): editor.IMarkerData[] {
  const markers: editor.IMarkerData[] = [];

  for (const err of errors) {
    if (!err.file || typeof err.line !== "number" || err.line < 1) continue;
    if (!previewErrorMatchesFile(err.file, editorFilePath)) continue;

    const line = err.line;
    const column = Math.max(1, err.column ?? 1);

    markers.push({
      severity:
        err.severity === "warning"
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Error,
      message: err.message,
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      endColumn: column + 1,
      source: err.framework || "preview",
    });
  }

  return markers;
}

export function applyPreviewMarkersToModel(
  model: editor.ITextModel,
  errors: ParsedError[],
  editorFilePath: string,
): void {
  const markers = previewErrorsToMarkers(errors, editorFilePath).map((m) => {
    const lineLen = model.getLineContent(m.startLineNumber).length;
    return {
      ...m,
      endColumn: Math.max(m.endColumn, lineLen + 1),
    };
  });
  monaco.editor.setModelMarkers(model, "atlarix-preview", markers);
}
