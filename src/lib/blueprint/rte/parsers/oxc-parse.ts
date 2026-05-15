/**
 * Lazy oxc-parser load — avoids hard crash when native binding is missing (dev safety net).
 */

import type { Program } from "@oxc-project/types";

type ParseSyncFn = (filename: string, source: string) => {
  errors: unknown[];
  program: Program;
};

let parseSyncFn: ParseSyncFn | null | undefined;

export function getOxcParseSync(): ParseSyncFn | null {
  if (parseSyncFn !== undefined) return parseSyncFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("oxc-parser") as { parseSync: ParseSyncFn };
    parseSyncFn = mod.parseSync;
  } catch {
    parseSyncFn = null;
  }
  return parseSyncFn;
}

export function oxcParseProgram(
  absolutePath: string,
  content: string,
): Program | null {
  const parseSync = getOxcParseSync();
  if (!parseSync) return null;
  try {
    const result = parseSync(absolutePath, content);
    if (result.errors.length > 0) return null;
    return result.program;
  } catch {
    return null;
  }
}
