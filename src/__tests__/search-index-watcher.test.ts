import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The watcher's FTS5 refresh used to be gated on the (removed) blueprint-cache
 * refresh — these tests pin the decoupled behavior: a changed code file drives
 * updateBm25IndexForFile directly, and ignored/non-code churn never does.
 */

const { updateSpy } = vi.hoisted(() => ({ updateSpy: vi.fn(async () => {}) }));
vi.mock("@/lib/search/bm25_semantic_index", () => ({
  updateBm25IndexForFile: updateSpy,
}));

import {
  ensureSearchIndexWatcher,
  shouldProcessWatcherPath,
} from "@/lib/search/search-index-watcher";
import { createIgnorerFromSource, BUILTIN_IGNORE } from "@/lib/atlarix/atlarix-ignore";

const tmpDirs: string[] = [];

afterEach(async () => {
  // Point the module's singleton watcher away from the temp dirs before removal.
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  updateSpy.mockClear();
});

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("search-index-watcher", () => {
  it("gates events on code extension + ignore rules", () => {
    const ig = createIgnorerFromSource(BUILTIN_IGNORE);
    expect(shouldProcessWatcherPath(ig, "src/app.ts")).toBe(true);
    expect(shouldProcessWatcherPath(ig, "node_modules/x/index.js")).toBe(false);
    expect(shouldProcessWatcherPath(ig, "README.md")).toBe(false);
  });

  it("refreshes the FTS5 index unconditionally for changed code files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-watch-"));
    tmpDirs.push(root);
    await fs.mkdir(path.join(root, "src"), { recursive: true });

    ensureSearchIndexWatcher(root, 42);
    // Give fs.watch a beat to arm before generating events.
    await new Promise((r) => setTimeout(r, 200));

    await fs.writeFile(path.join(root, "src", "thing.ts"), "export const x = 1;\n", "utf-8");

    await waitFor(() => updateSpy.mock.calls.length > 0);
    const [workspaceId, projectPath, rel] = updateSpy.mock.calls[0];
    expect(workspaceId).toBe(42);
    expect(projectPath).toBe(root);
    expect(rel).toBe("src/thing.ts");
  });
});
