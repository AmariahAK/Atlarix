/**
 * Doom Loop Detection - v7.1.2
 * Detects when the same tool is called repeatedly with same arguments.
 * OpenCode-inspired pattern for preventing infinite loops.
 *
 * This module complements src/lib/streaming/agentic-loop-repetition.ts
 * - agentic-loop-repetition.ts: Sliding window detection for write_file/run_command
 * - doom-loop.ts: General-purpose hash-based detection with time windows
 */

import { Log } from "../logging";

const logger = Log.scope("doom-loop");

export interface DoomLoopConfig {
  /** Max repeated calls before triggering prevention */
  maxRepeats: number;
  /** Time window in ms to track repetitions */
  windowMs: number;
}

const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
  maxRepeats: 3,
  windowMs: 30_000,
};

interface CallRecord {
  toolName: string;
  arguments: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

export class DoomLoopDetector {
  private config: DoomLoopConfig;
  private calls: Map<string, CallRecord> = new Map();
  private listeners: Array<(info: DoomLoopWarning) => void> = [];

  constructor(config: Partial<DoomLoopConfig> = {}) {
    this.config = { ...DEFAULT_DOOM_LOOP_CONFIG, ...config };
  }

  /**
   * Record a tool call and check for doom loop.
   * Returns warning info if doom loop detected, undefined otherwise.
   */
  recordAndCheck(
    toolName: string,
    arguments_: Record<string, unknown>
  ): DoomLoopWarning | undefined {
    const argsHash = hashArguments(arguments_);
    const key = `${toolName}:${argsHash}`;
    const now = new Date();

    let record = this.calls.get(key);
    if (!record) {
      record = {
        toolName,
        arguments: JSON.stringify(arguments_),
        count: 0,
        firstSeen: now,
        lastSeen: now,
      };
      this.calls.set(key, record);
    }

    record.count++;
    record.lastSeen = now;

    if (record.count >= this.config.maxRepeats) {
      const warning: DoomLoopWarning = {
        toolName,
        arguments: arguments_,
        repeatCount: record.count,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        elapsedMs: record.lastSeen.getTime() - record.firstSeen.getTime(),
      };

      logger.warn("Doom loop detected", {
        tool: toolName,
        repeats: record.count,
        elapsed: warning.elapsedMs,
      });

      this.notifyListeners(warning);
      return warning;
    }

    return undefined;
  }

  /**
   * Record a tool call without checking (fire and forget).
   */
  record(toolName: string, arguments_: Record<string, unknown>): void {
    this.recordAndCheck(toolName, arguments_);
  }

  /**
   * Clear all recorded calls.
   */
  clear(): void {
    this.calls.clear();
    logger.debug("Doom loop records cleared");
  }

  /**
   * Clear only records for a specific tool.
   */
  clearTool(toolName: string): void {
    for (const key of this.calls.keys()) {
      if (key.startsWith(`${toolName}:`)) {
        this.calls.delete(key);
      }
    }
  }

  /**
   * Add a listener for doom loop warnings.
   * Returns unsubscribe function.
   */
  onWarning(callback: (info: DoomLoopWarning) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Get current stats for debugging.
   */
  getStats(): DoomLoopStats {
    const now = Date.now();
    const activeCalls = Array.from(this.calls.values()).filter(
      (c) => now - c.lastSeen.getTime() < this.config.windowMs
    );

    return {
      trackedKeys: this.calls.size,
      activeKeys: activeCalls.length,
      maxRepeats: this.config.maxRepeats,
    };
  }

  private notifyListeners(warning: DoomLoopWarning): void {
    for (const listener of this.listeners) {
      try {
        listener(warning);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Cleanup old records (should be called periodically).
   */
  prune(): void {
    const cutoff = Date.now() - this.config.windowMs;
    for (const [key, record] of this.calls) {
      if (record.lastSeen.getTime() < cutoff) {
        this.calls.delete(key);
      }
    }
  }
}

export interface DoomLoopWarning {
  toolName: string;
  arguments: Record<string, unknown>;
  repeatCount: number;
  firstSeen: Date;
  lastSeen: Date;
  elapsedMs: number;
}

export interface DoomLoopStats {
  trackedKeys: number;
  activeKeys: number;
  maxRepeats: number;
}

function hashArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, Object.keys(args).sort());
  } catch {
    return String(args);
  }
}

let globalDetector: DoomLoopDetector | undefined;

export function getDoomLoopDetector(): DoomLoopDetector {
  if (!globalDetector) {
    globalDetector = new DoomLoopDetector();
  }
  return globalDetector;
}

export function checkForDoomLoop(
  toolName: string,
  args: Record<string, unknown>
): DoomLoopWarning | undefined {
  return getDoomLoopDetector().recordAndCheck(toolName, args);
}

/**
 * Integration helper for agentic-loop-repetition.ts
 * Provides a doom loop detector for tools outside the sliding window.
 */
export function createDoomLoopBridge(
  onDoomLoop: (warning: DoomLoopWarning) => void
): {
  recordToolCall: (toolName: string, args: Record<string, unknown>) => void;
  pruneAndGetStats: () => DoomLoopStats;
} {
  const detector = new DoomLoopDetector({ maxRepeats: 3, windowMs: 60_000 });

  detector.onWarning(onDoomLoop);

  return {
    recordToolCall: (toolName, args) => detector.record(toolName, args),
    pruneAndGetStats: () => {
      detector.prune();
      return detector.getStats();
    },
  };
}