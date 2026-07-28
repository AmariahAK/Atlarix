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
 * be imported from both registry-side code and chat-only paths.
 */
import log from "electron-log";
import { recordToolDuration } from "../perf/tool-perf";

export interface GuardOptions<T> {
  toolName: string;
  args: unknown;
  /**
   * Invoked with the alias-canonicalised args (see `canonicalizeParamAliases`).
   * Prefer this over closing over the raw `args`, or a model that sent
   * `file_path` reaches the handler without a `path`.
   */
  runWith?: (args: unknown) => Promise<T>;
  /**
   * JSON Schema for the tool's parameters (the same shape `createParameters`
   * in `registry.ts` produces). Pass `undefined` for MCP / external tools
   * whose schema is not exposed to the registry — the TOOL_ERROR trap still
   * applies, only the required-field check is skipped.
   */
  parametersSchema?: unknown;
  /**
   * Legacy form that closes over the caller's own args. Kept for callers that
   * don't take parameters (or don't need canonicalisation); `runWith` is
   * preferred. Exactly one of `runWith` / `runner` must be supplied.
   */
  runner?: () => Promise<T>;
}

export interface GuardError {
  success: false;
  error: "INVALID_PARAMS" | "TOOL_ERROR";
  message: string;
  tool: string;
  /** INVALID_PARAMS only: keys the caller did provide, for the model to diff against. */
  received?: string[];
}

/**
 * Parameter synonyms models emit instead of a schema's canonical name.
 *
 * Every other agent harness names the file parameter `file_path` (Claude Code's
 * Read/Edit/Write) or `filePath` (opencode), so models reach for those from
 * training prior and the call died as a missing required parameter. The system
 * prompt used to carry a standing clause telling the model our name is `path`:
 * that cost tokens on every turn and still missed sometimes.
 *
 * Absorbing it here is strictly better, and general — `read_file` had already
 * hand-declared `file_path` in its own schema (file.ts), which fixed exactly one
 * synonym for exactly one tool.
 *
 * Canonicalisation is conservative: it only fills a key the schema actually
 * declares, only when that key is absent, and never overwrites a value the
 * model got right. A tool with no `path` property is untouched.
 */
const PARAM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  path: ["file_path", "filePath", "filename", "file"],
};

export function canonicalizeParamAliases(schema: unknown, args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  if (!props || typeof props !== "object") return args;

  const a = args as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;

  for (const [canonical, aliases] of Object.entries(PARAM_ALIASES)) {
    if (!(canonical in props)) continue;
    if (a[canonical] !== undefined && a[canonical] !== null) continue;
    for (const alias of aliases) {
      const v = a[alias];
      if (typeof v === "string" && v.trim()) {
        out ??= { ...a };
        out[canonical] = v;
        break;
      }
    }
  }
  return out ?? args;
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
  const { toolName, args: rawArgs, parametersSchema, runner, runWith } = opts;

  // Fill canonical parameter names from the synonyms models actually emit,
  // BEFORE the required-field check — otherwise a `file_path` call is rejected
  // as missing `path` and the alias never reaches the handler.
  const args = canonicalizeParamAliases(parametersSchema, rawArgs);

  const missing = getMissingRequiredParams(parametersSchema, args);
  if (missing.length > 0) {
    const received = args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
    return {
      success: false,
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
    if (!runWith && !runner) {
      throw new Error("guardToolCall requires either runWith or runner");
    }
    const result = runWith ? await runWith(args) : await runner!();
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
      error: "TOOL_ERROR",
      tool: toolName,
      message: `Tool execution failed: ${message}. Please try a different approach.`,
    };
  }
}
