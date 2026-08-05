/**
 * Session-load timing diagnostic.
 *
 * WHY THIS EXISTS
 * ---------------
 * Opening an old session froze the window on macOS (spinning beach ball) with no
 * spinner — the loading overlay is delayed 1000 ms and the load never yields, so
 * React cannot paint it. "It's slow" had four plausible causes and no evidence:
 * the unbounded SQLite read, the `JSON.parse` of the display snapshots, the fact
 * that the renderer clones the entire payload BACK to main, or the two-to-three
 * re-parses of every assistant message. Guessing which one dominates would have
 * meant optimising something that wasn't the problem, so this measures first.
 *
 * The load spans two processes, so the switch does too:
 *   - main:     ATLARIX_DIAG_SESSION_LOAD=1
 *   - renderer: localStorage["atlarix:diag:session-load"] = "1"
 * (the renderer has no `process.env` — context isolation is on.)
 *
 * Off by default and cheap when off: one boolean read per span, no timers armed.
 */

/** Cached per process — the flag cannot change mid-run and this is on a hot path. */
let enabledCache: boolean | null = null;

export function sessionLoadDiagEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  let on = false;
  try {
    if (typeof process !== "undefined" && process.env) {
      on = process.env.ATLARIX_DIAG_SESSION_LOAD === "1";
    }
  } catch {
    /* no process (renderer) */
  }
  if (!on) {
    try {
      on =
        typeof localStorage !== "undefined" &&
        localStorage.getItem("atlarix:diag:session-load") === "1";
    } catch {
      /* no localStorage (main), or storage blocked */
    }
  }
  enabledCache = on;
  return on;
}

/** Test seam — the flag is cached, so tests need a way to re-read it. */
export function _resetSessionLoadDiagCache(): void {
  enabledCache = null;
}

type Sink = (line: string) => void;

const defaultSink: Sink = (line) => {
  // eslint-disable-next-line no-console -- a diagnostic's whole job is to print
  console.info(line);
};

/**
 * Time one labelled span. Returns the callback's value untouched, so a span can be
 * wrapped around existing code without restructuring it.
 *
 * Reports bytes when the caller can supply them: "340 ms" and "340 ms for 4.7 MB"
 * lead to different conclusions, and the whole question here is whether the cost
 * tracks payload size or message count.
 */
export async function diagSpan<T>(
  label: string,
  fn: () => Promise<T> | T,
  opts?: { sink?: Sink; bytes?: (result: T) => number; count?: (result: T) => number },
): Promise<T> {
  if (!sessionLoadDiagEnabled()) return await fn();
  const started = performance.now();
  const result = await fn();
  const ms = performance.now() - started;
  const bytes = opts?.bytes?.(result);
  const count = opts?.count?.(result);
  const extra = [
    count != null ? `${count} rows` : null,
    bytes != null ? `${(bytes / 1_048_576).toFixed(2)} MB` : null,
  ]
    .filter(Boolean)
    .join(", ");
  (opts?.sink ?? defaultSink)(
    `[diag:session-load] ${label} ${ms.toFixed(0)} ms${extra ? ` (${extra})` : ""}`,
  );
  return result;
}

/** Synchronous variant — for spans that must not be made async. */
export function diagSpanSync<T>(
  label: string,
  fn: () => T,
  opts?: { sink?: Sink; bytes?: (result: T) => number; count?: (result: T) => number },
): T {
  if (!sessionLoadDiagEnabled()) return fn();
  const started = performance.now();
  const result = fn();
  const ms = performance.now() - started;
  const bytes = opts?.bytes?.(result);
  const count = opts?.count?.(result);
  const extra = [
    count != null ? `${count} rows` : null,
    bytes != null ? `${(bytes / 1_048_576).toFixed(2)} MB` : null,
  ]
    .filter(Boolean)
    .join(", ");
  (opts?.sink ?? defaultSink)(
    `[diag:session-load] ${label} ${ms.toFixed(0)} ms${extra ? ` (${extra})` : ""}`,
  );
  return result;
}

/** A manual stopwatch, for spans whose start and end aren't in one function. */
export function diagStopwatch(label: string, sink?: Sink): { stop: (note?: string) => void } {
  if (!sessionLoadDiagEnabled()) return { stop: () => {} };
  const started = performance.now();
  return {
    stop: (note?: string) => {
      const ms = performance.now() - started;
      (sink ?? defaultSink)(
        `[diag:session-load] ${label} ${ms.toFixed(0)} ms${note ? ` (${note})` : ""}`,
      );
    },
  };
}

/** Byte size of a session payload, for correlating cost with size. */
export function measureSessionPayloadBytes(
  messages: {
    content?: string | null;
    modelContent?: string | null;
    displaySnapshot?: unknown;
  }[],
): { total: number; content: number; modelContent: number; displaySnapshot: number } {
  let content = 0;
  let modelContent = 0;
  let displaySnapshot = 0;
  for (const m of messages) {
    content += m.content?.length ?? 0;
    modelContent += m.modelContent?.length ?? 0;
    if (m.displaySnapshot != null) {
      // Already-parsed snapshots have no length; re-stringifying is only acceptable
      // because this runs exclusively when the diagnostic is switched on.
      displaySnapshot +=
        typeof m.displaySnapshot === "string"
          ? m.displaySnapshot.length
          : JSON.stringify(m.displaySnapshot).length;
    }
  }
  return {
    total: content + modelContent + displaySnapshot,
    content,
    modelContent,
    displaySnapshot,
  };
}
