/**
 * The schema catalogue: what the model is shown, and what it is not.
 *
 * Trimming here is not only a token saving. Three of the removals are part of the
 * guard, and the strongest kind — a capability absent from a schema is one the model
 * cannot express, which beats one it expresses and gets refused for. So the
 * assertions below are about CONTAINMENT as much as about size:
 *
 *   - `scope` gone and `target` narrowed to its window branch → the screen-absolute
 *     form is not offered at all.
 *   - the file-path fields gone → the filesystem reach is not advertised.
 *   - `element_token`/`element_index`/`snapshot_id` replaced by `ref` → the model is
 *     pointed at the addressing scheme Atlarix can actually guard.
 */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getName: () => "Atlarix",
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}));

const DRIVER = path.join(process.cwd(), "native", ".dist", "cua-driver");
const haveDriver = existsSync(DRIVER);
if (!haveDriver) {
  console.log("[computer-catalogue] native/.dist/cua-driver absent — live checks skipped");
}

function realTools(): Array<Record<string, unknown>> {
  const out = execFileSync(DRIVER, ["dump-docs", "--type", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const parsed = JSON.parse(out.slice(out.search(/[[{]/))) as {
    mcp?: { tools?: Array<Record<string, unknown>> };
  };
  return parsed.mcp?.tools ?? [];
}

describe("trimToolDoc", () => {
  it("replaces the three token fields with one ref", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const doc = trimToolDoc({
      name: "click",
      description: "Click a thing.",
      input_schema: {
        properties: {
          pid: { type: "integer" },
          element_token: { type: "string" },
          element_index: { type: "integer" },
          snapshot_id: { type: "string" },
        },
      },
    })!;
    expect(Object.keys(doc.properties).sort()).toEqual(["pid", "ref"]);
  });

  it("removes the screen-absolute scope and narrows target to a window", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const doc = trimToolDoc({
      name: "click",
      description: "Click.",
      input_schema: {
        properties: {
          scope: { type: "string", enum: ["window", "desktop"] },
          target: { anyOf: [{ oneOf: [{ kind: "window" }, { kind: "desktop" }] }] },
        },
      },
    })!;
    expect(doc.properties).not.toHaveProperty("scope");
    // `target` is KEPT, not dropped: `move_cursor` has no top-level pid, so
    // dropping it would leave that tool unaddressable.
    expect(JSON.stringify(doc.properties.target)).toContain("window");
    expect(JSON.stringify(doc.properties.target)).not.toContain("desktop");
  });

  it("removes the fields Atlarix owns or refuses", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const doc = trimToolDoc({
      name: "clipboard_write",
      description: "Write.",
      input_schema: {
        properties: {
          text: { type: "string" },
          session: { type: "string" },
          file_path: { type: "string" },
          image_path: { type: "string" },
          screenshot_out_file: { type: "string" },
        },
        required: ["text", "session"],
      },
    })!;
    expect(Object.keys(doc.properties)).toEqual(["text"]);
    // A required list that still names a stripped field would make every call look
    // malformed to a model reading the schema.
    expect(doc.required).toEqual(["text"]);
  });

  it("cuts a long description at a boundary, never mid-sentence", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const long = `${"First sentence here. ".repeat(40)}`;
    const doc = trimToolDoc({ name: "x", description: long, input_schema: {} })!;
    expect(doc.description.length).toBeLessThanOrEqual(451);
    // A half-sentence reads to a model as a complete instruction.
    expect(doc.description.endsWith(".")).toBe(true);
  });

  it("keeps a short description whole", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const doc = trimToolDoc({ name: "x", description: "Short.", input_schema: {} })!;
    expect(doc.description).toBe("Short.");
  });
});

describe.skipIf(!haveDriver)("against the shipped driver", () => {
  it("has a schema for every model-facing tool", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const { DISPATCH } = await import("@/lib/computer/dispatch");
    const byName = new Map(realTools().map((t) => [String(t.name), t]));

    for (const name of Object.keys(DISPATCH)) {
      const raw = byName.get(name);
      expect(raw, `${name} has no entry in dump-docs`).toBeTruthy();
      const doc = trimToolDoc(raw!);
      expect(doc, `${name} produced no doc`).toBeTruthy();
      expect(doc!.description.length, `${name} has an empty description`).toBeGreaterThan(0);
    }
  }, 30_000);

  it("never advertises a screen-absolute or filesystem field", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const { DISPATCH, REFUSED_FIELDS, HOST_OWNED_FIELDS } = await import(
      "@/lib/computer/dispatch"
    );
    const byName = new Map(realTools().map((t) => [String(t.name), t]));

    for (const name of Object.keys(DISPATCH)) {
      const doc = trimToolDoc(byName.get(name)!)!;
      const keys = Object.keys(doc.properties);
      expect(keys, `${name} still offers scope`).not.toContain("scope");
      for (const f of [...REFUSED_FIELDS, ...HOST_OWNED_FIELDS]) {
        expect(keys, `${name} still offers ${f}`).not.toContain(f);
      }
      expect(JSON.stringify(doc.properties), `${name} still offers a desktop target`).not.toMatch(
        /"desktop"/,
      );
    }
  }, 30_000);

  it("costs a few hundred tokens per schema, not a few thousand", async () => {
    const { trimToolDoc } = await import("@/lib/computer/tool-catalogue");
    const { DISPATCH } = await import("@/lib/computer/dispatch");
    const byName = new Map(realTools().map((t) => [String(t.name), t]));

    // The whole design rests on a schema being cheap enough to fetch on demand. Raw,
    // `click` is 6.3 KB; if trimming ever stops working, this is where it shows.
    let worst = 0;
    let worstName = "";
    for (const name of Object.keys(DISPATCH)) {
      const size = JSON.stringify(trimToolDoc(byName.get(name)!)).length;
      if (size > worst) {
        worst = size;
        worstName = name;
      }
    }
    expect(worst, `${worstName} is ${worst} bytes`).toBeLessThan(3_000);
  }, 30_000);
});
