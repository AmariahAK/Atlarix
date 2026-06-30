/**
 * Sliding-window repetition detection for the build-mode agentic tool loop.
 * Keep `normalizeRunCommandTarget` in sync with `PermissionInterceptor.executeRunCommand`
 * (cd /workspace prefix strip) in `src/ipc/handlers/permissions/interceptor.ts`.
 *
 * Read-side tools (read_file, explore_folder, search) are tracked with a
 * larger window because the round-cache dedup layer already serves them
 * cheaply on repeat. The point of detecting their loops is to escape the
 * stream-stall watchdog: the model can hammer the same read call until the
 * provider goes silent for 30s, at which point the watchdog aborts. Catching
 * the loop earlier gives the model a "stop looping" correction instead.
 */

const RECENT_WINDOW = 5;
const STUCK_THRESHOLD = 3;
/**
 * Read-side tools (read_file / explore_folder / search) deserve a larger
 * window before we self-correct: the model often re-reads after a related
 * tool call, which is benign. We start nudging only when 6 of the last 10
 * calls are the same read target — at which point it is clearly stuck.
 */
const READ_RECENT_WINDOW = 10;
// Loosened 6→5: a model re-deriving the same understanding re-reads ONE file
// while interleaving other reads/searches, so its key sat at ~5-of-10 and never
// reached the old 6 threshold — it span for many minutes untripped. 5-of-10 of
// the SAME read target is already wasteful (the result is in context), and the
// only consequence of an early trip is a benign "you already have it" nudge
// (force-finish needs sustained repetition past two nudges).
const READ_STUCK_THRESHOLD = 5;

const READ_TOOL_NAMES = new Set([
  "read_file",
  "explore_folder",
  "search",
]);

/** Same regex as PermissionInterceptor.executeRunCommand — strip generic /workspace cd prefix. */
const WORKSPACE_CD_STRIP = /^cd\s+\/workspace(?:\/[^\s;&|]*)?\s*(?:&&|;)\s*/;

export function normalizeWriteFileTarget(raw: string): string {
  return raw.trim().split(/[/\\]+/).join("/");
}

export function normalizeRunCommandTarget(command: string): string {
  const c = command.trim();
  if (WORKSPACE_CD_STRIP.test(c)) {
    return c.replace(WORKSPACE_CD_STRIP, "").trim() || "true";
  }
  return c;
}

function normalizeFsPath(raw: string): string {
  return raw.trim().split(/[/\\]+/).join("/").replace(/^\.\//, "");
}

export function buildRepetitionKey(toolName: string, args: unknown): string | null {
  if (
    toolName !== "write_file" &&
    toolName !== "edit_file" &&
    toolName !== "run_command" &&
    !READ_TOOL_NAMES.has(toolName)
  ) {
    return null;
  }
  if (!args || typeof args !== "object") return null;
  const o = args as Record<string, unknown>;
  if (toolName === "write_file") {
    if (typeof o.path !== "string" || !o.path.trim()) return null;
    return `write_file:${normalizeWriteFileTarget(o.path)}`;
  }
  if (toolName === "edit_file") {
    // v13.8: edit_file absorbed write_file. Track whole-file writes in the SAME
    // key space as the old write_file so write-loops are still caught; leave the
    // surgical ops untracked (distinct edits to one file are normal, not a loop).
    if (o.operation !== "write") return null;
    if (typeof o.path !== "string" || !o.path.trim()) return null;
    return `write_file:${normalizeWriteFileTarget(o.path)}`;
  }
  if (toolName === "run_command") {
    if (typeof o.command !== "string" || !o.command.trim()) return null;
    return `run_command:${normalizeRunCommandTarget(o.command)}`;
  }
  if (toolName === "read_file") {
    // The tool schema accepts either `path` or `file_path` (alias).
    const raw =
      typeof o.path === "string" && o.path.trim()
        ? o.path
        : typeof o.file_path === "string" && o.file_path.trim()
          ? o.file_path
          : null;
    if (!raw) return null;
    return `read_file:${normalizeFsPath(raw)}`;
  }
  if (toolName === "explore_folder") {
    if (typeof o.path !== "string" || !o.path.trim()) return null;
    return `explore_folder:${normalizeFsPath(o.path)}`;
  }
  if (toolName === "search") {
    if (typeof o.query !== "string" || !o.query.trim()) return null;
    // Key on query + scoped path so identical queries against different
    // folders count as distinct calls. Mode is intentionally excluded —
    // the model often retries the same query with mode=auto then mode=text.
    const scope = typeof o.path === "string" && o.path.trim() ? normalizeFsPath(o.path) : "*";
    return `search:${o.query.trim().slice(0, 200)}|${scope}`;
  }
  return null;
}

/** Internal: which sliding-window thresholds apply for this key family. */
function thresholdsForKey(key: string): { window: number; stuck: number } {
  const colon = key.indexOf(":");
  const family = colon >= 0 ? key.slice(0, colon) : key;
  if (READ_TOOL_NAMES.has(family)) {
    return { window: READ_RECENT_WINDOW, stuck: READ_STUCK_THRESHOLD };
  }
  return { window: RECENT_WINDOW, stuck: STUCK_THRESHOLD };
}

export type AgenticRepetitionOutcome =
  | { kind: "none" }
  | { kind: "loop_detected"; toolName: string; target: string; count: number }
  | { kind: "loop_abort"; toolName: string; target: string; count: number };

export type AgenticRepetitionState = {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  record(toolName: string, args: unknown): AgenticRepetitionOutcome;
  takePendingCorrection(): string | null;
  consumeLoopBreak(): boolean;
};

function correctionMessage(toolName: string, displayTarget: string): string {
  const target = displayTarget ? ` \`${displayTarget.slice(0, 500)}\`` : "";
  // Read-side loops are almost always "the model forgot it already has this":
  // tell it the content is already in context and how to get MORE of it (page
  // with offset) instead of re-reading from the top.
  if (READ_TOOL_NAMES.has(toolName)) {
    return [
      `You already called ${toolName}${target} — its result is already in the conversation above.`,
      "Don't repeat it; use what you already have. To see a different part of a large file, call read_file with offset/limit to page forward instead of re-reading from the start.",
    ].join(" ");
  }
  return [
    "You appear to be repeating the same action (" +
      toolName +
      (target ? ` on${target}` : "") +
      ") multiple times.",
    "Step back and reconsider your approach. What is the actual problem you are trying to solve?",
  ].join(" ");
}

export function createAgenticRepetitionState(): AgenticRepetitionState {
  let enabled = false;
  let windowKeys: string[] = [];
  let correctionsInjected = 0;
  let pendingCorrection: string | null = null;

  return {
    setEnabled(v: boolean) {
      enabled = v;
      windowKeys = [];
      pendingCorrection = null;
      correctionsInjected = 0;
    },
    isEnabled() {
      return enabled;
    },
    record(toolName: string, args: unknown): AgenticRepetitionOutcome {
      if (!enabled) return { kind: "none" };
      const key = buildRepetitionKey(toolName, args);
      if (!key) return { kind: "none" };

      // Per-key sliding-window: read-side tools get a larger window so a
      // benign re-read between unrelated calls doesn't trigger a correction,
      // while write/run loops trip the existing tighter threshold.
      const { window: keyWindow, stuck: keyStuck } = thresholdsForKey(key);
      const effectiveWindow = Math.max(RECENT_WINDOW, keyWindow);
      windowKeys.push(key);
      if (windowKeys.length > effectiveWindow) {
        windowKeys.shift();
      }

      const count = windowKeys.filter((k) => k === key).length;
      if (count < keyStuck) return { kind: "none" };

      const colon = key.indexOf(":");
      const op = colon >= 0 ? key.slice(0, colon) : toolName;
      const target = colon >= 0 ? key.slice(colon + 1) : "";

      if (correctionsInjected < 2) {
        correctionsInjected++;
        windowKeys = [];
        pendingCorrection = correctionMessage(op, target);
        return {
          kind: "loop_detected",
          toolName: op,
          target: target.slice(0, 240),
          count: keyStuck,
        };
      }

      // Repetition detected past the nudge budget. The hard loop-break is
      // disabled (consumeLoopBreak always returns false), so this is now an
      // advisory classification only — the loop continues.
      return {
        kind: "loop_abort",
        toolName: op,
        target: target.slice(0, 240),
        count: keyStuck,
      };
    },
    takePendingCorrection() {
      const t = pendingCorrection;
      pendingCorrection = null;
      return t;
    },
    consumeLoopBreak() {
      // Hard loop-break on repetition is DISABLED: a repeated tool call no
      // longer ends the turn (it was an unintended stopper). The ≤2 nudge
      // corrections above still fire as benign steering; the model decides when
      // it is done.
      return false;
    },
  };
}
