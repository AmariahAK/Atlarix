import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectManifestsHint, rootManifests } from "@/lib/project-manifests";

const dirs: string[] = [];
function workspace(files: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "manifests-"));
  dirs.push(d);
  for (const f of files) fs.writeFileSync(path.join(d, f), "");
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the project's own manifests, named in the prompt", () => {
  it("names what is at the root, and says not to assume package.json", () => {
    const d = workspace(["Cargo.toml", "Makefile", "README.md"]);
    expect(rootManifests(d)).toEqual(["Cargo.toml", "Makefile"]);
    const hint = projectManifestsHint(d);
    expect(hint).toContain("`Cargo.toml`, `Makefile`");
    expect(hint).toContain("do not assume");
  });

  it("says when there is no manifest at all", () => {
    expect(projectManifestsHint(workspace(["notes.md"]))).toMatch(/no common build manifest/);
  });

  it("matches .csproj and .sln by suffix", () => {
    expect(rootManifests(workspace(["App.csproj", "App.sln"]))).toEqual(["App.csproj", "App.sln"]);
  });

  it("is empty with no workspace", () => {
    expect(projectManifestsHint(undefined)).toBe("");
  });
});
