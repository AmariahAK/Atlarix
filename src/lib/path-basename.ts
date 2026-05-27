/** Last path segment — safe in the renderer (no node:path). */
export function basenameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segment = normalized.split("/").filter(Boolean).pop();
  return segment ?? "";
}
