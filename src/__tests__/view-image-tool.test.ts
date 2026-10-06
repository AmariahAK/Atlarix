/**
 * view_image returns an image file in the shape the turn sends to a vision
 * model (extractImageMedia), and read_file points images at it instead of
 * returning them as mojibake.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/media";
import "@/lib/tools/file";
import {
  extractImageMedia,
  buildToolModelOutput,
} from "@/lib/ai/tool-model-output";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

let ws: string;

beforeAll(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-view-image-"));
  fs.mkdirSync(path.join(ws, "frames"));
  fs.writeFileSync(path.join(ws, "frames", "f_001.png"), PNG);
  fs.writeFileSync(path.join(ws, "notes.txt"), "BMI table, not an image\n");
});

const run = (name: string, args: Record<string, unknown>) =>
  ToolRegistry.get(name)!.handler({
    ...args,
    workspace: ws,
  } as never) as Promise<Record<string, unknown>>;

describe("view_image", () => {
  it("returns the image in the vision shape, marked as a file the agent opened", async () => {
    const r = await run("view_image", { path: "frames/f_001.png" });
    expect(r.success).toBe(true);
    expect(r.mimeType).toBe("image/png");
    expect(r.data).toBe(PNG.toString("base64"));
    const media = extractImageMedia(r);
    expect(media?.origin).toBe("file");
  });

  it("captions it as a file, and refuses to pretend on a model that can't see it", async () => {
    const r = await run("view_image", { path: "frames/f_001.png" });
    const seen = buildToolModelOutput("view_image", r, {
      builtinProviderId: "anthropic",
      modelApiId: "claude-opus-5-5",
    });
    expect(JSON.stringify(seen)).toContain("Image file frames/f_001.png");
    const blind = buildToolModelOutput("view_image", r, {
      builtinProviderId: "deepseek",
      modelApiId: "deepseek-chat",
    });
    expect(blind?.type).toBe("text");
    expect(String((blind as { value: string }).value)).toMatch(
      /have NOT seen it/,
    );
  });

  it("refuses a file that is not an image, and a missing one", async () => {
    expect((await run("view_image", { path: "notes.txt" })).success).toBe(
      false,
    );
    expect(
      String((await run("view_image", { path: "nope.png" })).error),
    ).toMatch(/No file/);
  });

  it("read_file points an image at view_image, and still reads text starting with BM", async () => {
    const img = await run("read_file", { path: "frames/f_001.png" });
    expect(img.success).toBe(false);
    expect(String(img.error)).toMatch(/view_image/);
    const txt = await run("read_file", { path: "notes.txt" });
    expect(JSON.stringify(txt)).toContain("BMI table");
  });
});
