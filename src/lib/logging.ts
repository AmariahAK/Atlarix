/**
 * Atlarix Logging Service - v7.1.2
 * OpenCode-inspired service-based logging with timing support.
 */

import log from "electron-log";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  timestamp: Date;
  service: string;
  message: string;
  data?: Record<string, unknown>;
  durationMs?: number;
}

type LogListener = (entry: LogEntry) => void;

const serviceLoggers = new Map<string, ReturnType<typeof log.scope>>();
const listeners = new Set<LogListener>();

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  time(label: string): DisposableTimer;
}

export interface DisposableTimer {
  readonly startTime: Date;
  dispose(): void;
}

function createServiceLogger(service: string): Logger {
  let electronLogger = serviceLoggers.get(service);
  if (!electronLogger) {
    electronLogger = log.scope(service);
    serviceLoggers.set(service, electronLogger);
  }

  const formatData = (data?: Record<string, unknown>): string => {
    if (!data || Object.keys(data).length === 0) return "";
    const entries = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    return ` ${entries}`;
  };

  const emit = (level: LogEntry["level"], message: string, data?: Record<string, unknown>) => {
    const entry: LogEntry = {
      level,
      timestamp: new Date(),
      service,
      message,
      data,
    };
    for (const listener of listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors
      }
    }
  };

  return {
    debug: (message: string, data?: Record<string, unknown>) => {
      electronLogger.debug(message + formatData(data));
      emit("debug", message, data);
    },
    info: (message: string, data?: Record<string, unknown>) => {
      electronLogger.info(message + formatData(data));
      emit("info", message, data);
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      electronLogger.warn(message + formatData(data));
      emit("warn", message, data);
    },
    error: (message: string, data?: Record<string, unknown>) => {
      electronLogger.error(message + formatData(data));
      emit("error", message, data);
    },
    time: (label: string): DisposableTimer => {
      const startTime = new Date();
      return {
        startTime,
        dispose: () => {
          const durationMs = Date.now() - startTime.getTime();
          electronLogger.info(`[timing] ${label} completed in ${durationMs}ms`);
          emit("info", `[timing] ${label} completed`, { durationMs });
        },
      };
    },
  };
}

export const Log = {
  create: createServiceLogger,

  onLog(listener: LogListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  scope: (service: string) => createServiceLogger(service),
};

export type { LogEntry, LogListener };