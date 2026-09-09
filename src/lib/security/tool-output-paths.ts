import os from "node:os";
import path from "node:path";

const TOOL_OUTPUT_DIR = path.join(os.tmpdir(), "atlarix-tool-outputs");

/** Read-only access for read_file on large tool spill files. */
export function isAllowedToolOutputPath(fullPath: string): boolean {
  const normalized = path.normalize(fullPath);
  const base = path.normalize(TOOL_OUTPUT_DIR);
  if (!normalized.startsWith(base + path.sep) && normalized !== base) {
    return false;
  }
  return normalized.endsWith(".txt");
}
