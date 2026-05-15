/**
 * Atlarix Tool-Call Guard
 * =======================
 * Shared safety net wrapping every tool execution path:
 *
 *  - FIX 3 (param validation): missing required JSON-schema fields short-circuit
 *    with a structured `INVALID_PARAMS` result instead of letting the handler
 *    throw deep inside the AI SDK.
 *  - FIX 3 (TOOL_ERROR trap): thrown handler errors are caught and converted
 *    into a structured response. No tool ever throws to the caller.
 *  - `__permission_required` markers pass through unchanged so the downstream
 *    interceptor (`permissions/interceptor.ts`) can still detect them.
 *
 * The function is renderer-safe: it only imports electron-log (which itself
 * has a renderer entry) and pure JS. Place under `src/lib/tools/` so it can
 * be imported from both registry-side code and chat-only / counsel paths.
 */
import log from "electron-log";
import { recordToolDuration } from "../perf/tool-perf";

export interface GuardOptions<T> {
  toolName: string;
  args: unknown;
  /**
   * JSON Schema for the tool's parameters (the same shape `createParameters`
   * in `registry.ts` produces). Pass `undefined` for MCP / external tools
   * whose schema is not exposed to the registry — the TOOL_ERROR trap still
   * applies, only the required-field check is skipped.
   */
  parametersSchema?: unknown;
  runner: () => Promise<T>;
}

export interface GuardError {
  success: false;
  cost: 0;
  error: "INVALID_PARAMS" | "TOOL_ERROR";
  message: string;
  tool: string;
  /** INVALID_PARAMS only: keys the caller did provide, for the model to diff against. */
  received?: string[];
}

/**
 * Walk a JSON Schema `required: string[]` array and return any keys absent
 * (or explicitly null/undefined) in `args`. Returns the full required list
 * if `args` is not an object. Returns [] if the schema has no `required[]`.
 */
export function getMissingRequiredParams(
  schema: unknown,
  args: unknown,
): string[] {
  if (
    !schema ||
    typeof schema !== "object" ||
    !Array.isArray((schema as { required?: unknown }).required)
  ) {
    return [];
  }
  const required = (schema as { required: string[] }).required;
  if (!args || typeof args !== "object") return required.slice();
  const a = args as Record<string, unknown>;
  return required.filter((k) => a[k] === undefined || a[k] === null);
}

/**
 * Wrap a tool execution with param validation and a TOOL_ERROR trap.
 * Returns either the runner's result (untouched) or a structured `GuardError`.
 * Permission-required markers pass through untouched.
 */
export async function guardToolCall<T>(
  opts: GuardOptions<T>,
): Promise<T | GuardError> {
  const { toolName, args, parametersSchema, runner } = opts;

  const missing = getMissingRequiredParams(parametersSchema, args);
  if (missing.length > 0) {
    const received = args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
    return {
      success: false,
      cost: 0,
      error: "INVALID_PARAMS",
      tool: toolName,
      message: `Missing required parameter(s): ${missing.join(", ")}. Please retry with all required fields.`,
      received,
    };
  }

  const t0 = Date.now();
  void import("@sentry/electron/main")
    .then((Sentry) => {
      Sentry.addBreadcrumb({
        category: "tool",
        message: `start:${toolName}`,
        level: "info",
      });
    })
    .catch(() => {});

  try {
    const result = await runner();
    const ms = Date.now() - t0;
    recordToolDuration(toolName, ms);
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "tool",
          message: `end:${toolName}`,
          level: "info",
          data: { ms },
        });
      })
      .catch(() => {});
    return result;
  } catch (err) {
    log.error(`[tool:${toolName}] Unhandled error:`, err);
    void import("@sentry/electron/main")
      .then((Sentry) => {
        Sentry.addBreadcrumb({
          category: "tool",
          message: `error:${toolName}`,
          level: "error",
        });
      })
      .catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      cost: 0,
      error: "TOOL_ERROR",
      tool: toolName,
      message: `Tool execution failed: ${message}. Please try a different approach.`,
    };
  }
}
