/**
 * Shared tool-schema normalizer for the Vercel AI SDK (v5+).
 *
 * `ToolRegistry` entries declare their `parameters` as **plain JSON Schema**
 * (see `createParameters` in `src/lib/tools/registry.ts`). MCP servers also
 * advertise JSON Schema. Some inline tools use Zod (`message_agent` etc.).
 *
 * The AI SDK's `streamText` / `generateText` runs every `tool.inputSchema`
 * through `zodToJsonSchema()` -> `parseDef()`, which reads `_def.typeName`.
 * If you hand it raw JSON Schema, that lookup blows up with
 * `TypeError: Cannot read properties of undefined (reading 'typeName')`.
 *
 * Always pipe `tool.inputSchema` through this normalizer before handing the
 * `ToolSet` to the AI SDK.
 */
import { jsonSchema as aiJsonSchema, zodSchema } from "ai";
import type { JSONSchema7 } from "json-schema";
import log from "electron-log";

const logger = log.scope("normalize-tool-schema");

export const PERMISSIVE_TOOL_JSON_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

type SchemaObj = Record<string, unknown>;

function isPlainObject(v: unknown): v is SchemaObj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * A "bare property map" is what several inline tools hand-write as `parameters`:
 * `{ workspace: { type: "string", ... }, port: { type: "number", ... } }` —
 * i.e. an object whose VALUES are JSON-Schema nodes but which itself carries no
 * `type`/`properties`/`$schema` wrapper. Left alone, the AI SDK can't read it and
 * we fall back to an empty permissive schema (dropping every parameter). Detect
 * it so we can wrap it as `{ type: "object", properties: <obj> }` instead.
 */
function looksLikeBarePropMap(obj: SchemaObj): boolean {
  const schemaKeywords = [
    "type",
    "$schema",
    "$ref",
    "properties",
    "anyOf",
    "oneOf",
    "allOf",
    "enum",
    "items",
  ];
  if (schemaKeywords.some((k) => k in obj)) return false;
  const values = Object.values(obj);
  if (values.length === 0) return false;
  return values.every(
    (v) =>
      isPlainObject(v) &&
      ("type" in v ||
        "enum" in v ||
        "$ref" in v ||
        "properties" in v ||
        "anyOf" in v ||
        "oneOf" in v ||
        "allOf" in v),
  );
}

/**
 * Recursively repair a JSON Schema node into a fresh, valid object:
 * - Strips property-level `required: true/false` booleans (invalid JSON Schema —
 *   `required` must be an array of property names), hoisting the names of props
 *   marked `required: true` into the parent object's top-level `required` array.
 *   Strict provider validators (e.g. Mistral) reject the bool form with
 *   "False is not of type 'array'"; lenient providers silently ignore it.
 * - Drops any stray boolean `required` sitting on a node directly.
 * Never mutates the input (the registry holds these objects long-term).
 */
function repairSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(repairSchemaNode);
  if (!isPlainObject(node)) return node;

  const out: SchemaObj = { ...node };

  if (isPlainObject(out.properties)) {
    const newProps: SchemaObj = {};
    const requiredFromProps: string[] = [];
    for (const [propName, propSchemaRaw] of Object.entries(out.properties)) {
      let propSchema = propSchemaRaw;
      if (
        isPlainObject(propSchema) &&
        typeof propSchema.required === "boolean"
      ) {
        if (propSchema.required === true) requiredFromProps.push(propName);
        const { required: _drop, ...rest } = propSchema;
        propSchema = rest;
      }
      newProps[propName] = repairSchemaNode(propSchema);
    }
    out.properties = newProps;
    if (requiredFromProps.length > 0) {
      const existing = Array.isArray(out.required)
        ? (out.required as string[])
        : [];
      out.required = Array.from(new Set([...existing, ...requiredFromProps]));
    }
  }

  // A boolean `required` directly on this node is invalid — drop it.
  if (typeof out.required === "boolean") {
    delete out.required;
  }

  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "if",
    "then",
    "else",
    "not",
  ]) {
    if (isPlainObject(out[key])) out[key] = repairSchemaNode(out[key]);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(out[key]))
      out[key] = (out[key] as unknown[]).map(repairSchemaNode);
  }
  for (const key of ["$defs", "definitions"]) {
    if (isPlainObject(out[key])) {
      const cloned: SchemaObj = {};
      for (const [n, v] of Object.entries(out[key] as SchemaObj)) {
        cloned[n] = repairSchemaNode(v);
      }
      out[key] = cloned;
    }
  }

  return out;
}

/**
 * Make a tool's JSON Schema safe for strict-validating providers (Mistral, etc.)
 * without losing information:
 * - wraps a bare property-map in `{ type: "object", properties }`;
 * - repairs invalid `required` booleans (see `repairSchemaNode`).
 * Apply at every site that hands a raw tool schema to `aiJsonSchema(...)`.
 */
export function sanitizeJsonSchemaForProvider(schema: unknown): JSONSchema7 {
  if (!isPlainObject(schema)) return PERMISSIVE_TOOL_JSON_SCHEMA;
  let root: SchemaObj = schema;
  if (looksLikeBarePropMap(root)) {
    root = { type: "object", properties: root, required: [] };
  }
  return repairSchemaNode(root) as JSONSchema7;
}

/**
 * Wire a tool's parameter schema for `streamText` / `generateText` tools.
 * - Pass Zod through `zodSchema()` so the provider gets real parameter shapes (not empty `{}`).
 * - Pass JSON-Schema-shaped objects through `aiJsonSchema()`.
 * - If a Zod schema hits an AI SDK conversion bug, fall back to permissive schema for that tool only.
 */
export function normalizeToolInputSchemaForAiSdk(schema: unknown) {
  if (!schema || typeof schema !== "object") {
    return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
  }
  const obj = schema as Record<string, unknown>;
  if ("_def" in obj) {
    try {
      return zodSchema(obj as unknown as Parameters<typeof zodSchema>[0], {
        useReferences: true,
      });
    } catch (e) {
      logger.warn(
        "Tool input Zod schema could not be wrapped for AI SDK; using permissive schema:",
        e,
      );
      return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
    }
  }
  if ("type" in obj || "$schema" in obj) {
    return aiJsonSchema(sanitizeJsonSchemaForProvider(obj));
  }
  if (
    "jsonSchema" in obj &&
    obj.jsonSchema &&
    typeof obj.jsonSchema === "object"
  ) {
    return aiJsonSchema(sanitizeJsonSchemaForProvider(obj.jsonSchema));
  }
  // Bare property-map (e.g. `{ workspace: { type: "string" }, ... }`): wrap +
  // sanitize so the model still gets real parameters instead of an empty schema.
  if (looksLikeBarePropMap(obj)) {
    return aiJsonSchema(sanitizeJsonSchemaForProvider(obj));
  }
  return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
}
