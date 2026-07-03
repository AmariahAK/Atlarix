import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// v14.8.10 Fix G: the write path keeps the FTS5/BM25 layer fresh for the
// turn's own writes (fire-and-forget single-file upsert). Without it, nothing
// updates the index mid-session and a just-written file ranks WORST in grep's
// rerank ("the grep index is stale").
const updateSpy = vi.fn(async () => {});
vi.mock("@/lib/search/bm25_semantic_index", () => ({
  updateBm25IndexForFile: (...a: unknown[]) => updateSpy(...(a as [])),
}));

import { PermissionInterceptor } from "@/ipc/handlers/permissions/interceptor";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-idx-test-"));
}

describe("interceptor write path → search-index refresh", () => {
  it("upserts the written file into the BM25/FTS5 index (workspaceId + rel path)", async () => {
    const ws = tmpWorkspace();
    const interceptor = new PermissionInterceptor(ws, 7);
    await (
      interceptor as unknown as {
        executeWriteFile(req: unknown): Promise<void>;
      }
    ).executeWriteFile({
      preview: { path: "src/new.ts", content: "export const y = 2;\n" },
    });
    // Fire-and-forget — allow the microtask + dynamic import to settle.
    await vi.waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy).toHaveBeenCalledWith(7, ws, "src/new.ts");
    // The write itself landed.
    expect(fs.readFileSync(path.join(ws, "src/new.ts"), "utf-8")).toContain("y = 2");
  });

  it("skips silently when no workspaceId is bound (no throw, write still lands)", async () => {
    updateSpy.mockClear();
    const ws = tmpWorkspace();
    const interceptor = new PermissionInterceptor(ws);
    await (
      interceptor as unknown as {
        executeWriteFile(req: unknown): Promise<void>;
      }
    ).executeWriteFile({
      preview: { path: "b.ts", content: "export const b = 1;\n" },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ws, "b.ts"))).toBe(true);
  });
});
