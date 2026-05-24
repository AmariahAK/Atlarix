import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasCtags } from "./helpers/native-tools";

vi.mock("@/ipc/utils/project-files", () => ({
  getProjectFiles: vi.fn(async (_root: string) => ({
    files: ["src/index.ts", "src/helper.ts"],
    strategy: "fallback" as const,
    count: 2,
  })),
}));

vi.mock("@/lib/blueprint/rte/ast-grep/run-structural-scan", () => ({
  runStructuralScan: vi.fn(async (_root: string, _files: string[], symbols: unknown[]) => ({
    nodes: (symbols as Array<{ id: string; name: string; kind: string; path: string; line: number }>).map(
      (s) => ({
        id: s.id,
        type: "function" as const,
        name: s.name,
        file: s.path,
        line: s.line,
      }),
    ),
    edges: [],
  })),
}));

import { generateBlueprint, blueprintEngineLabel } from "../lib/blueprint/rte/parsers";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function makeFixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-gen-"));
  tmpDirs.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture" }),
    "utf-8",
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "index.ts"),
    "export function main() { return 1; }\nimport { helper } from './helper';\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(root, "src", "helper.ts"),
    "export function helper() { return 2; }\n",
    "utf-8",
  );
  return root;
}

describe.skipIf(!hasCtags())("generateBlueprint", () => {
  it("returns nodes from ctags and optional ast-grep edges", async () => {
    const root = await makeFixture();
    const result = await generateBlueprint(root);
    expect(result).not.toBeNull();
    expect(result!.nodes.length).toBeGreaterThan(0);
    expect(["ast-grep+ctags", "file-tree", "hybrid"]).toContain(blueprintEngineLabel(result));
  });
});

describe("generateBlueprint fallback", () => {
  it("returns null when project language cannot be detected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-empty-"));
    tmpDirs.push(root);
    const result = await generateBlueprint(root);
    expect(result).toBeNull();
  });
});
