/**
 * Path matching for preview/runtime errors → open editor file (no Monaco import).
 */

export function cleanPreviewErrorFilePath(rawPath: string): string | null {
  if (
    rawPath.includes("cdn.jsdelivr.net") ||
    rawPath.includes("unpkg.com") ||
    rawPath.includes("node_modules") ||
    rawPath.includes("esm.sh")
  ) {
    return null;
  }

  if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
    try {
      const url = new URL(rawPath);
      const pathname = url.pathname.replace(/^\//, "");
      if (!pathname || pathname === "/") return null;
      return pathname;
    } catch {
      return null;
    }
  }

  return rawPath;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function previewErrorMatchesFile(
  errorFile: string,
  editorFilePath: string,
): boolean {
  const clean = cleanPreviewErrorFilePath(errorFile);
  if (!clean) return false;
  const editor = normalizePath(editorFilePath);
  const err = normalizePath(clean);
  return (
    editor === err ||
    editor.endsWith("/" + err) ||
    err.endsWith("/" + editor)
  );
}
