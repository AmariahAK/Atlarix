/**
 * Per-chat debug hypothesis — required before write tools in Debug (Fix) mode.
 */

export type DebugHypothesisRecord = {
  hypothesis: string;
  likelyFiles: string[];
  evidence?: string;
  recordedAt: number;
};

const sessions = new Map<number, DebugHypothesisRecord>();

export const DEBUG_WRITE_TOOL_NAMES = [
  "delete_file",
  "edit_file",
  "rename_file",
  "write_file",
  "write_multiple_files",
] as const;

export type DebugWriteToolName = (typeof DEBUG_WRITE_TOOL_NAMES)[number];

export function isDebugWriteTool(toolName: string): toolName is DebugWriteToolName {
  return (DEBUG_WRITE_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function setDebugHypothesis(
  chatId: number,
  record: Omit<DebugHypothesisRecord, "recordedAt">,
): DebugHypothesisRecord {
  const entry: DebugHypothesisRecord = {
    ...record,
    hypothesis: record.hypothesis.trim(),
    likelyFiles: record.likelyFiles ?? [],
    recordedAt: Date.now(),
  };
  sessions.set(chatId, entry);
  return entry;
}

export function clearDebugHypothesis(chatId: number): void {
  sessions.delete(chatId);
}

export function hasActiveDebugHypothesis(chatId: number): boolean {
  const h = sessions.get(chatId)?.hypothesis?.trim();
  return Boolean(h && h.length > 0);
}

/** Optional inline hypothesis on a write tool call (records/replaces session). */
export function adoptInlineDebugHypothesis(
  chatId: number,
  args: unknown,
): boolean {
  if (!args || typeof args !== "object") return false;
  const raw = (args as { hypothesis?: unknown }).hypothesis;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const likelyRaw = (args as { likely_files?: unknown }).likely_files;
  const likelyFiles = Array.isArray(likelyRaw)
    ? likelyRaw.filter((x): x is string => typeof x === "string")
    : [];
  setDebugHypothesis(chatId, {
    hypothesis: raw.trim(),
    likelyFiles,
  });
  return true;
}

export function debugWriteGateMessage(): string {
  return (
    "Debug mode requires a root-cause hypothesis before changing files. " +
    "Call record_debug_hypothesis({ hypothesis, likely_files?, evidence? }) first, " +
    "or pass hypothesis on this tool call. Then apply a minimal fix tied to that hypothesis."
  );
}
