/**
 * In-process ring buffer of recent tool durations (main process).
 * Used by dev /perf overlay and optional Sentry correlation.
 */

const MAX = 40;
const entries: { name: string; ms: number; at: number }[] = [];

export function recordToolDuration(toolName: string, ms: number): void {
  entries.push({ name: toolName, ms, at: Date.now() });
  while (entries.length > MAX) entries.shift();
}

export function getToolPerfSnapshot(): { name: string; ms: number; at: number }[] {
  return [...entries];
}
