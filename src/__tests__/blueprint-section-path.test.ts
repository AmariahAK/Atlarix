import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listWorkspaceSectionCandidates,
  validateBlueprintFocusPath,
} from "@/lib/blueprint/section-path";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-section-"));
  tmpDirs.push(root);
  await fs.mkdir(path.join(root, "packages"));
  await fs.mkdir(path.join(root, "packages", "api"));
  await fs.mkdir(path.join(root, "legacy-pkg"));
  await fs.writeFile(path.join(root, "legacy-pkg", "pyproject.toml"), "[tool.poetry]\n");
  return root;
}

describe("validateBlueprintFocusPath", () => {
  it("accepts an existing section folder", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, "packages/api");
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.scanRoot).toContain("api");
    }
  });

  it("suggests correction for typo legacy-pkgx", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, "legacy-pkgx");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.suggestions).toContain("legacy-pkg");
    }
  });

  it("returns no suggestions when nothing is close", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, "zzzznonexistent999");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.suggestions.length).toBe(0);
    }
  });

  it("rejects workspace root focus_path '.' with section suggestions", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, ".");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.suggestions).toContain("packages");
      expect(r.error).toMatch(/not/i);
    }
  });

  it("allows workspace root when allowWorkspaceRoot is set", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, ".", { allowWorkspaceRoot: true });
    expect(r.valid).toBe(true);
  });
});

describe("listWorkspaceSectionCandidates", () => {
  it("lists top-level directories excluding dot dirs", async () => {
    const ws = await makeWorkspace();
    const dirs = await listWorkspaceSectionCandidates(ws);
    expect(dirs).toContain("packages");
    expect(dirs).toContain("legacy-pkg");
    expect(dirs.some((d) => d.startsWith("."))).toBe(false);
  });
});
