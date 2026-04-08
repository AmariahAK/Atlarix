/**
 * StreamManager — v3.9
 * Collects terminal or pipeline output for AI tools (stream_terminal_output, stream_pipeline_logs).
 */

export type StreamSource = "terminal" | "pipeline";

export type TerminalStreamMode = "error_first" | "progress_first" | "raw_capped";

export interface Stream {
  id: string;
  source: StreamSource;
  chatId: number | null;
  filter: RegExp | null;
  maxLines: number;
  /** Optional max bytes collected (approx). */
  maxBytes: number;
  collectedBytes: number;
  collectedLines: string[];
  /** Stream mode used when filter is not provided (terminal only). */
  mode?: TerminalStreamMode;
  /** Dedupe: last collected line. */
  lastLine?: string | null;
  active: boolean;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  /** For pipeline: optional job id. */
  jobId?: number;
}

const streams = new Map<string, Stream>();
let nextId = 0;

function nextStreamId(): string {
  return `stream-${++nextId}-${Date.now()}`;
}

/**
 * Open a terminal or pipeline stream. Terminal streams collect output via feedTerminalOutput.
 */
export function openStream(
  source: StreamSource,
  options: {
    chatId?: number | null;
    filter?: string | null;
    maxLines?: number;
    maxBytes?: number;
    timeoutMs?: number;
    jobId?: number;
    mode?: TerminalStreamMode;
  } = {}
): string {
  const {
    chatId = null,
    filter = null,
    maxLines = 50,
    maxBytes = 64_000,
    timeoutMs = 30_000,
    jobId,
    mode,
  } = options;

  const id = nextStreamId();
  const stream: Stream = {
    id,
    source,
    chatId,
    filter: filter ? new RegExp(filter, "i") : null,
    maxLines: Math.min(Math.max(1, maxLines), 200),
    maxBytes: Math.max(1024, Math.min(Number(maxBytes) || 64_000, 1_000_000)),
    collectedBytes: 0,
    collectedLines: [],
    mode,
    lastLine: null,
    active: true,
    timeoutHandle: null,
    jobId,
  };

  if (timeoutMs > 0) {
    stream.timeoutHandle = setTimeout(() => {
      stream.active = false;
      stream.timeoutHandle = null;
    }, timeoutMs);
  }

  streams.set(id, stream);
  return id;
}

export function closeStream(streamId: string): void {
  const stream = streams.get(streamId);
  if (stream) {
    stream.active = false;
    if (stream.timeoutHandle) {
      clearTimeout(stream.timeoutHandle);
      stream.timeoutHandle = null;
    }
    streams.delete(streamId);
  }
}

export function getCollectedLines(streamId: string): { lines: string[]; active: boolean } {
  const stream = streams.get(streamId);
  if (!stream) {
    return { lines: [], active: false };
  }
  return { lines: [...stream.collectedLines], active: stream.active };
}

export function listActiveStreams(): Array<{ id: string; source: StreamSource; chatId: number | null }> {
  return Array.from(streams.values())
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, source: s.source, chatId: s.chatId }));
}

/** Call when terminal output is received (e.g. from permission interceptor). Feeds matching streams for this chat. */
export function feedTerminalOutput(chatId: number, output: string): void {
  const text = typeof output === "string" ? output : String(output);
  const lines = text.split(/\r?\n/);
  const defaultErrorRe = /\b(error|failed|exception|traceback|fatal|warn(ing)?)\b/i;

  for (const stream of streams.values()) {
    if (!stream.active || stream.source !== "terminal") continue;
    if (stream.chatId != null && stream.chatId !== chatId) continue;

    const re = stream.filter;
    const mode: TerminalStreamMode = stream.mode ?? "error_first";

    const pushLine = (line: string) => {
      const s = line ?? "";
      if (stream.lastLine && s === stream.lastLine) return;
      stream.lastLine = s;
      const bytes = Buffer.byteLength(s, "utf8") + 1;
      if (stream.collectedLines.length >= stream.maxLines || stream.collectedBytes + bytes > stream.maxBytes) {
        stream.active = false;
        if (stream.timeoutHandle) {
          clearTimeout(stream.timeoutHandle);
          stream.timeoutHandle = null;
        }
        return;
      }
      stream.collectedLines.push(s);
      stream.collectedBytes += bytes;
    };

    if (re) {
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          for (let j = start; j < end; j++) {
            pushLine(lines[j]);
            if (!stream.active) break;
          }
        }
      }
    } else {
      for (const line of lines) {
        if (!line) continue;
        if (mode === "error_first") {
          if (defaultErrorRe.test(line)) {
            pushLine(line);
          }
        } else if (mode === "progress_first") {
          // Keep most lines but avoid obvious spammy progress bars.
          if (!/^\s*(\d+%|\[=+>\s*\]\s*\d+%|(?:\u25A0|\u25A1|\u2591|\u2592|\u2593)+)\s*$/.test(line)) {
            pushLine(line);
          }
        } else {
          pushLine(line);
        }
        if (!stream.active) break;
      }
    }
  }
}

/** Feed pipeline log lines (e.g. from GitHub Actions poll). Used by stream_pipeline_logs. */
export function feedPipelineLines(
  streamId: string,
  lines: string[],
  filter?: RegExp | null
): void {
  const stream = streams.get(streamId);
  if (!stream || stream.source !== "pipeline") return;

  for (const line of lines) {
    if (filter && !filter.test(line)) continue;
    if (stream.collectedLines.length >= stream.maxLines) {
      stream.active = false;
      break;
    }
    stream.collectedLines.push(line);
  }
}

export function setStreamInactive(streamId: string): void {
  const stream = streams.get(streamId);
  if (stream) {
    stream.active = false;
    if (stream.timeoutHandle) {
      clearTimeout(stream.timeoutHandle);
      stream.timeoutHandle = null;
    }
  }
}
