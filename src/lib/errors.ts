/**
 * Atlarix Error Types - v7.1.2
 * Structured error classes for typed error handling.
 */

export class AtlarixError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AtlarixError";
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
    };
  }
}

export class CompactionError extends AtlarixError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "COMPACTION_ERROR", context);
    this.name = "CompactionError";
  }
}

export class ToolExecutionError extends AtlarixError {
  constructor(
    message: string,
    public toolName: string,
    context?: Record<string, unknown>
  ) {
    super(message, "TOOL_EXECUTION_ERROR", { toolName, ...context });
    this.name = "ToolExecutionError";
  }
}

export class TokenBudgetError extends AtlarixError {
  constructor(
    message: string,
    public usedTokens: number,
    public budgetTokens: number,
    context?: Record<string, unknown>
  ) {
    super(message, "TOKEN_BUDGET_ERROR", { usedTokens, budgetTokens, ...context });
    this.name = "TokenBudgetError";
  }
}

export class ModelSelectionError extends AtlarixError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "MODEL_SELECTION_ERROR", context);
    this.name = "ModelSelectionError";
  }
}

export class WorkspaceError extends AtlarixError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "WORKSPACE_ERROR", context);
    this.name = "WorkspaceError";
  }
}

export class PermissionError extends AtlarixError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "PERMISSION_ERROR", context);
    this.name = "PermissionError";
  }
}

export class StreamError extends AtlarixError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "STREAM_ERROR", context);
    this.name = "StreamError";
  }
}

export function isAtlarixError(error: unknown): error is AtlarixError {
  return error instanceof AtlarixError;
}

export function getErrorCode(error: unknown): string {
  if (isAtlarixError(error)) return error.code;
  if (error instanceof Error) return "UNKNOWN";
  return "UNKNOWN";
}

export function getErrorContext(error: unknown): Record<string, unknown> | undefined {
  if (isAtlarixError(error)) return error.context;
  return undefined;
}

export function formatError(error: unknown): string {
  if (isAtlarixError(error)) {
    return `[${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createContextFromError(error: unknown): Record<string, unknown> {
  return {
    errorCode: getErrorCode(error),
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
    ...getErrorContext(error),
  };
}