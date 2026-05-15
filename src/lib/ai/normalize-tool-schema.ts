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
            return zodSchema(
                obj as unknown as Parameters<typeof zodSchema>[0],
                { useReferences: true },
            );
        } catch (e) {
            logger.warn(
                "Tool input Zod schema could not be wrapped for AI SDK; using permissive schema:",
                e,
            );
            return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
        }
    }
    if ("type" in obj || "$schema" in obj) {
        return aiJsonSchema(obj as JSONSchema7);
    }
    if ("jsonSchema" in obj && obj.jsonSchema && typeof obj.jsonSchema === "object") {
        return aiJsonSchema(obj.jsonSchema as JSONSchema7);
    }
    return aiJsonSchema(PERMISSIVE_TOOL_JSON_SCHEMA);
}
