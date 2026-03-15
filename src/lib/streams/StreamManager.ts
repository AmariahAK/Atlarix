/**
 * StreamManager — v3.9
 * Collects terminal or pipeline output for AI tools (stream_terminal_output, stream_pipeline_logs).
 */

export type StreamSource = "terminal" | "pipeline";

export interface Stream {
  id: string;
  source: StreamSource;
  chatId: number | null;
  filter: RegExp | null;
  maxLines: number;
  collectedLines: string[];
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
    timeoutMs?: number;
    jobId?: number;
  } = {}
): string {
  const {
    chatId = null,
    filter = null,
    maxLines = 50,
    timeoutMs = 30_000,
    jobId,
  } = options;

  const id = nextStreamId();
  const stream: Stream = {
    id,
    source,
    chatId,
    filter: filter ? new RegExp(filter, "i") : null,
    maxLines: Math.min(Math.max(1, maxLines), 200),
    collectedLines: [],
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

  for (const stream of streams.values()) {
    if (!stream.active || stream.source !== "terminal") continue;
    if (stream.chatId != null && stream.chatId !== chatId) continue;

    const re = stream.filter;
    if (re) {
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 3);
          for (let j = start; j < end; j++) {
            if (stream.collectedLines.length >= stream.maxLines) {
              stream.active = false;
              if (stream.timeoutHandle) {
                clearTimeout(stream.timeoutHandle);
                stream.timeoutHandle = null;
              }
              break;
            }
            stream.collectedLines.push(lines[j]);
          }
        }
      }
    } else {
      for (const line of lines) {
        if (stream.collectedLines.length >= stream.maxLines) {
          stream.active = false;
          if (stream.timeoutHandle) {
            clearTimeout(stream.timeoutHandle);
            stream.timeoutHandle = null;
          }
          break;
        }
        stream.collectedLines.push(line);
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
