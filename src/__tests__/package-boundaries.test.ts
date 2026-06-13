import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { detectPackages } from "@/lib/search/package-boundaries";

/**
 * Builds a throwaway monorepo-shaped tree:
 *   <root>/package.json                 (root)
 *   <root>/packages/api/package.json    (api package)
 *   <root>/packages/web/package.json    (web package)
 *   <root>/services/worker/go.mod       (go package)
 *   <root>/vendored/.git + Cargo.toml   (nested repo — should still be a pkg)
 *   <root>/node_modules/dep/package.json (ignored — never descended into)
 */
let root: string;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "pkg-boundaries-"));
  const mk = async (rel: string, marker: string) => {
    await fsp.mkdir(path.join(root, rel), { recursive: true });
    await fsp.writeFile(path.join(root, rel, marker), "{}");
  };
  await mk(".", "package.json");
  await mk("packages/api", "package.json");
  await mk("packages/api/src", "ignore.txt"); // not a marker
  await mk("packages/web", "package.json");
  await mk("services/worker", "go.mod");
  await mk("vendored", "Cargo.toml");
  await fsp.mkdir(path.join(root, "vendored/.git"), { recursive: true });
  await mk("node_modules/dep", "package.json"); // must be skipped
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("detectPackages", () => {
  it("finds every sub-package root and ignores vendor dirs", async () => {
    const map = await detectPackages(root);
    expect(map.roots).toContain(".");
    expect(map.roots).toContain("packages/api");
    expect(map.roots).toContain("packages/web");
    expect(map.roots).toContain("services/worker");
    expect(map.roots).toContain("vendored");
    // node_modules is never descended into → its package.json doesn't count.
    expect(map.roots).not.toContain("node_modules/dep");
  });

  it("maps a file to its NEAREST enclosing package", async () => {
    const map = await detectPackages(root);
    expect(map.packageFor("packages/api/src/server.ts")).toBe("packages/api");
    expect(map.packageFor("packages/web/index.ts")).toBe("packages/web");
    expect(map.packageFor("services/worker/main.go")).toBe("services/worker");
    expect(map.packageFor("vendored/lib.rs")).toBe("vendored");
    // A file under no sub-package falls back to the workspace root.
    expect(map.packageFor("scripts/build.ts")).toBe(".");
    expect(map.packageFor("README.md")).toBe(".");
  });

  it("normalizes windows-style separators", async () => {
    const map = await detectPackages(root);
    expect(map.packageFor("packages\\api\\src\\x.ts")).toBe("packages/api");
  });

  it("degrades to root-only on a non-existent path", async () => {
    const map = await detectPackages(path.join(root, "does-not-exist"));
    expect(map.roots).toEqual(["."]);
    expect(map.packageFor("anything/here.ts")).toBe(".");
  });
});

// Sanity: the fixture really did create the nested .git marker dir.
it("fixture has the expected markers on disk", () => {
  expect(fs.existsSync(path.join(root, "vendored/.git"))).toBe(true);
});
