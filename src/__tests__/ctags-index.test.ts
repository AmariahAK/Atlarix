import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSymbolIndex,
  getSymbolsForFile,
  invalidateSymbolIndex,
  isSymbolIndexWarm,
  updateSymbolIndexForFile,
} from "../lib/index/ctags-index";
import { hasCtags } from "./helpers/native-tools";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeTsFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-ctags-"));
  tmpDirs.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), "export function app() {}\n", "utf-8");
  return root;
}

describe.skipIf(!hasCtags())("ctags-index", () => {
  it("builds and caches symbol index on disk", async () => {
    const root = await makeTsFixture();
    const cache = await ensureSymbolIndex(root);
    expect(cache.symbols.length).toBeGreaterThan(0);
    expect(cache.manifest.engine).toBe("ctags");

    const symbols = getSymbolsForFile(cache, "src/app.ts");
    expect(symbols.some((s) => s.name === "app")).toBe(true);

    const warm = await isSymbolIndexWarm(root);
    expect(warm).toBe(true);

    invalidateSymbolIndex(root);
    const warmAfter = await isSymbolIndexWarm(root);
    expect(warmAfter).toBe(false);
  });

  it("incrementally updates symbols for a single file", async () => {
    const root = await makeTsFixture();
    await ensureSymbolIndex(root);

    await fs.writeFile(
      path.join(root, "src", "app.ts"),
      "export function app() {}\nexport function helper() {}\n",
      "utf-8",
    );

    const updated = await updateSymbolIndexForFile(root, "src/app.ts");
    const symbols = getSymbolsForFile(updated, "src/app.ts");
    expect(symbols.some((s) => s.name === "helper")).toBe(true);
    expect(await isSymbolIndexWarm(root)).toBe(true);
  });
});
