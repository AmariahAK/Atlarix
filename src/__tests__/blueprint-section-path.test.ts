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
  await fs.mkdir(path.join(root, "spacinsider-cli"));
  await fs.mkdir(path.join(root, "airtable2newpostgres"));
  await fs.writeFile(path.join(root, "airtable2newpostgres", "pyproject.toml"), "[tool.poetry]\n");
  return root;
}

describe("validateBlueprintFocusPath", () => {
  it("accepts an existing section folder", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, "spacinsider-cli");
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.scanRoot).toContain("spacinsider-cli");
    }
  });

  it("suggests correction for typo airtable2newpostgress", async () => {
    const ws = await makeWorkspace();
    const r = await validateBlueprintFocusPath(ws, "airtable2newpostgress");
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.suggestions).toContain("airtable2newpostgres");
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
});

describe("listWorkspaceSectionCandidates", () => {
  it("lists top-level directories excluding dot dirs", async () => {
    const ws = await makeWorkspace();
    const dirs = await listWorkspaceSectionCandidates(ws);
    expect(dirs).toContain("spacinsider-cli");
    expect(dirs).toContain("airtable2newpostgres");
    expect(dirs.some((d) => d.startsWith("."))).toBe(false);
  });
});
