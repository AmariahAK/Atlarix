import { describe, expect, it } from "vitest";
import {
  sanitizeJsonSchemaForProvider,
  PERMISSIVE_TOOL_JSON_SCHEMA,
} from "@/lib/ai/normalize-tool-schema";

describe("sanitizeJsonSchemaForProvider", () => {
  it("wraps a bare property-map and preserves its parameters", () => {
    // Pattern used by inline tools like live_preview / rename_file: a raw map of
    // prop -> schema with no `type`/`properties` wrapper. Previously this fell
    // back to an empty permissive schema, dropping every parameter.
    const bare = {
      workspace: { type: "string", description: "Project directory", required: false },
      workspaceId: { type: "number", description: "Workspace ID", required: true },
    };
    const out = sanitizeJsonSchemaForProvider(bare) as Record<string, any>;
    expect(out.type).toBe("object");
    expect(Object.keys(out.properties)).toEqual(["workspace", "workspaceId"]);
    expect(out.properties.workspace).toEqual({ type: "string", description: "Project directory" });
    // `required: true` props are hoisted into the top-level required array.
    expect(out.required).toEqual(["workspaceId"]);
  });

  it("strips invalid property-level `required` booleans and hoists the true ones", () => {
    // Pattern produced by createParameters(props, []) when props carry stray
    // `required: true/false`. Strict providers (Mistral) reject the bool form
    // with "False is not of type 'array'".
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", required: true },
        b: { type: "string", required: false },
        c: { type: "string" },
      },
      required: [],
    };
    const out = sanitizeJsonSchemaForProvider(schema) as Record<string, any>;
    expect(out.properties.a).toEqual({ type: "string" });
    expect(out.properties.b).toEqual({ type: "string" });
    expect(out.properties.c).toEqual({ type: "string" });
    expect(out.required).toEqual(["a"]);
  });

  it("merges hoisted required names with an existing required array (deduped)", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string", required: true },
        b: { type: "string" },
      },
      required: ["a", "b"],
    };
    const out = sanitizeJsonSchemaForProvider(schema) as Record<string, any>;
    expect(out.required.sort()).toEqual(["a", "b"]);
  });

  it("recurses into nested object properties", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            inner: { type: "string", required: true },
          },
        },
      },
    };
    const out = sanitizeJsonSchemaForProvider(schema) as Record<string, any>;
    expect(out.properties.nested.properties.inner).toEqual({ type: "string" });
    expect(out.properties.nested.required).toEqual(["inner"]);
  });

  it("leaves an already-valid schema unchanged in shape", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const out = sanitizeJsonSchemaForProvider(schema) as Record<string, any>;
    expect(out).toEqual(schema);
  });

  it("does not mutate the input schema", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string", required: true } },
      required: [],
    };
    const snapshot = JSON.parse(JSON.stringify(schema));
    sanitizeJsonSchemaForProvider(schema);
    expect(schema).toEqual(snapshot);
  });

  it("returns the permissive schema for non-object input", () => {
    expect(sanitizeJsonSchemaForProvider(null)).toBe(PERMISSIVE_TOOL_JSON_SCHEMA);
    expect(sanitizeJsonSchemaForProvider("nope")).toBe(PERMISSIVE_TOOL_JSON_SCHEMA);
  });
});
