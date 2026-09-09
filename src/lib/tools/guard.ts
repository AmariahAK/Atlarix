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

/** What a JSON-Schema `type` says a value should be. Anything else is left alone. */
type CoercibleType = "string" | "number" | "integer" | "boolean" | "array";

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Coerce ONE value toward the schema's declared type, or report that it can't be.
 *
 * The posture matches `PARAM_ALIASES` above: absorb what the model unambiguously
 * meant, refuse what would be a guess. We deliberately target weak and local
 * models, which emit `file_path: ["src/a.ts"]`, `background: "true"` and
 * `max_length: "500"` regularly — every one of those has exactly one sane
 * reading, so failing the call teaches the model nothing a retry wouldn't cost.
 *
 * A MULTI-element array is the case that must never be coerced: picking
 * `["a.ts", "b.ts"][0]` would silently edit one file and drop the other, which
 * is worse than the error. Same for objects — there is no defensible reading.
 */
function coerceToSchemaType(
  value: unknown,
  type: CoercibleType,
): { ok: true; value: unknown } | { ok: false } {
  const actual = jsonTypeOf(value);

  // Unwrap a single-element array for any scalar target, then fall through so
  // the unwrapped value is itself coerced (`["500"]` → `"500"` → `500`).
  if (actual === "array" && type !== "array") {
    const arr = value as unknown[];
    if (arr.length !== 1) return { ok: false };
    return coerceToSchemaType(arr[0], type);
  }

  switch (type) {
    case "string":
      if (actual === "string") return { ok: true, value };
      // A number or boolean rendered as text is lossless and unambiguous.
      if (actual === "number" || actual === "boolean") {
        return { ok: true, value: String(value) };
      }
      return { ok: false };

    case "number":
    case "integer": {
      if (actual === "number") {
        const n = value as number;
        if (!Number.isFinite(n)) return { ok: false };
        if (type === "integer" && !Number.isInteger(n)) return { ok: false };
        return { ok: true, value: n };
      }
      if (actual === "string") {
        const s = (value as string).trim();
        if (!s) return { ok: false };
        const n = Number(s);
        if (!Number.isFinite(n)) return { ok: false };
        if (type === "integer" && !Number.isInteger(n)) return { ok: false };
        return { ok: true, value: n };
      }
      return { ok: false };
    }

    case "boolean": {
      if (actual === "boolean") return { ok: true, value };
      if (actual === "string") {
        const s = (value as string).trim().toLowerCase();
        if (s === "true") return { ok: true, value: true };
        if (s === "false") return { ok: true, value: false };
      }
      return { ok: false };
    }

    case "array":
      if (actual === "array") return { ok: true, value };
      // A bare scalar where a list was asked for is a list of one. Objects are
      // not — `{a:1}` could mean the object itself or its values.
      if (actual === "string" || actual === "number" || actual === "boolean") {
        return { ok: true, value: [value] };
      }
      return { ok: false };
  }
}

/** Human-readable rendering of what actually arrived, for the model to diff against. */
function describeReceived(value: unknown): string {
  const actual = jsonTypeOf(value);
  if (actual === "array") {
    return `an array of ${(value as unknown[]).length}`;
  }
  if (actual === "object") return "an object";
  if (actual === "null") return "null";
  return `${actual} (${JSON.stringify(value)})`;
}

export interface CoerceParamTypesResult {
  args: unknown;
  /** One entry per parameter that could not be coerced. Empty on success. */
  invalid: Array<{ key: string; expected: string; received: string }>;
}

/**
 * Bring argument types in line with the tool's declared JSON Schema.
 *
 * Runs BEFORE the required-field check, because a coerced value must count as
 * present — and AFTER alias canonicalisation, so `file_path: ["x"]` is first
 * moved to `path` and only then unwrapped.
 *
 * Parameters the schema does not declare, and declared types we do not model
 * (`object`, unions, `null`), pass through untouched: this narrows behaviour to
 * exactly the mistakes we can read, rather than policing the whole payload.
 */
export function coerceParamTypes(
  schema: unknown,
  args: unknown,
): CoerceParamTypesResult {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { args, invalid: [] };
  }
  const props = (schema as { properties?: Record<string, unknown> } | null)
    ?.properties;
  if (!props || typeof props !== "object") return { args, invalid: [] };

  const a = args as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const invalid: CoerceParamTypesResult["invalid"] = [];

  for (const [key, rawProp] of Object.entries(props)) {
    if (!(key in a)) continue;
    const value = a[key];
    // Absent is the required-check's business, not ours.
    if (value === undefined || value === null) continue;

    const declared = (rawProp as { type?: unknown } | null)?.type;
    if (typeof declared !== "string") continue;
    if (
      declared !== "string" &&
      declared !== "number" &&
      declared !== "integer" &&
      declared !== "boolean" &&
      declared !== "array"
    ) {
      continue;
    }

    const coerced = coerceToSchemaType(value, declared);
    if (!coerced.ok) {
      invalid.push({
        key,
        expected: declared,
        received: describeReceived(value),
      });
      continue;
    }
    if (coerced.value !== value) {
      out ??= { ...a };
      out[key] = coerced.value;
    }
  }

  return { args: out ?? args, invalid };
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

export function canonicalizeParamAliases(
  schema: unknown,
  args: unknown,
): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const props = (schema as { properties?: Record<string, unknown> } | null)
    ?.properties;
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
  const aliased = canonicalizeParamAliases(parametersSchema, rawArgs);

  // Then line the TYPES up with the schema. Also before the required check, so a
  // coerced value counts as present rather than reading as missing.
  const { args, invalid } = coerceParamTypes(parametersSchema, aliased);
  if (invalid.length > 0) {
    const received =
      args && typeof args === "object"
        ? Object.keys(args as Record<string, unknown>)
        : [];
    const detail = invalid
      .map(
        (p) => `\`${p.key}\` expects ${p.expected} but received ${p.received}`,
      )
      .join("; ");
    // A rejection here never reaches the permission interceptor, which is the
    // only other thing that logs a tool call — so without this line a refused
    // call leaves NO trace at all. Three `edit_file` calls came back
    // INVALID_PARAMS in one session and the log had nothing to say about any of
    // them, while every call that succeeded was logged twice.
    log.warn(
      `[tool:${toolName}] INVALID_PARAMS (type): ${detail}; received=[${received.join(", ")}]`,
    );
    return {
      success: false,
      error: "INVALID_PARAMS",
      tool: toolName,
      // Say what was wrong AND what to send instead: a guard that only reports
      // costs a round trip the model has to guess its way out of.
      message: `Wrong parameter type(s): ${detail}. Retry with the declared type — pass a single value, not a list, when the schema asks for one.`,
      received,
    };
  }

  const missing = getMissingRequiredParams(parametersSchema, args);
  if (missing.length > 0) {
    const received =
      args && typeof args === "object"
        ? Object.keys(args as Record<string, unknown>)
        : [];
    log.warn(
      `[tool:${toolName}] INVALID_PARAMS (missing): ${missing.join(", ")}; received=[${received.join(", ")}]`,
    );
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
