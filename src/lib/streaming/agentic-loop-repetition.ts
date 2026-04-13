/**
 * Sliding-window repetition detection for the build-mode agentic tool loop.
 * Keep `normalizeRunCommandTarget` in sync with `PermissionInterceptor.executeRunCommand`
 * (cd /workspace prefix strip) in `src/ipc/handlers/permissions/interceptor.ts`.
 */

const RECENT_WINDOW = 5;
const STUCK_THRESHOLD = 3;

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

export function buildRepetitionKey(toolName: string, args: unknown): string | null {
  if (toolName !== "write_file" && toolName !== "run_command") return null;
  if (!args || typeof args !== "object") return null;
  const o = args as Record<string, unknown>;
  if (toolName === "write_file") {
    if (typeof o.path !== "string" || !o.path.trim()) return null;
    return `write_file:${normalizeWriteFileTarget(o.path)}`;
  }
  if (typeof o.command !== "string" || !o.command.trim()) return null;
  return `run_command:${normalizeRunCommandTarget(o.command)}`;
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
  return [
    "You appear to be repeating the same action (" +
      toolName +
      (displayTarget ? ` on \`${displayTarget.slice(0, 500)}\`` : "") +
      ") multiple times.",
    "Step back and reconsider your approach. What is the actual problem you are trying to solve?",
  ].join(" ");
}

export function createAgenticRepetitionState(): AgenticRepetitionState {
  let enabled = false;
  let windowKeys: string[] = [];
  let correctionsInjected = 0;
  let pendingCorrection: string | null = null;
  let loopBreakPending = false;

  return {
    setEnabled(v: boolean) {
      enabled = v;
      windowKeys = [];
      pendingCorrection = null;
      loopBreakPending = false;
      correctionsInjected = 0;
    },
    isEnabled() {
      return enabled;
    },
    record(toolName: string, args: unknown): AgenticRepetitionOutcome {
      if (!enabled) return { kind: "none" };
      const key = buildRepetitionKey(toolName, args);
      if (!key) return { kind: "none" };

      windowKeys.push(key);
      if (windowKeys.length > RECENT_WINDOW) {
        windowKeys.shift();
      }

      const count = windowKeys.filter((k) => k === key).length;
      if (count < STUCK_THRESHOLD) return { kind: "none" };

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
          count: STUCK_THRESHOLD,
        };
      }

      loopBreakPending = true;
      return {
        kind: "loop_abort",
        toolName: op,
        target: target.slice(0, 240),
        count: STUCK_THRESHOLD,
      };
    },
    takePendingCorrection() {
      const t = pendingCorrection;
      pendingCorrection = null;
      return t;
    },
    consumeLoopBreak() {
      const b = loopBreakPending;
      loopBreakPending = false;
      return b;
    },
  };
}
