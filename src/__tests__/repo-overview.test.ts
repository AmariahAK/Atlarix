import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildRepoOverviewMarkdown } from "../lib/tools/repo-overview";

describe("buildRepoOverviewMarkdown", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "repo-overview-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("includes README and entry points when present", async () => {
    await fs.writeFile(path.join(tmpRoot, "README.md"), "# Demo\n\nHello world\n");
    await fs.writeFile(path.join(tmpRoot, "package.json"), '{"name":"demo","scripts":{"start":"node index.js"}}');
    await fs.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "src", "index.ts"), "export default function main() {}\n");

    const result = await buildRepoOverviewMarkdown({ workspaceRoot: tmpRoot });
    expect(result.success).toBe(true);
    expect(result.markdown).toContain("## README (excerpt)");
    expect(result.markdown).toContain("Hello world");
    expect(result.markdown).toMatch(/## Entry points/);
    expect(result.markdown).toContain("src/index.ts");
  });

  it("notes missing README", async () => {
    const result = await buildRepoOverviewMarkdown({ workspaceRoot: tmpRoot });
    expect(result.markdown).toContain("_No README found");
  });

  it("emits entry-point hints when no standard entry", async () => {
    await fs.writeFile(path.join(tmpRoot, "run.sh"), "#!/bin/sh\necho hi\n");
    const result = await buildRepoOverviewMarkdown({ workspaceRoot: tmpRoot });
    expect(result.markdown).toContain("_No standard entry point detected._");
    expect(result.markdown).toMatch(/Hints:/);
  });

  it("lists subprojects for monorepo layout", async () => {
    await fs.mkdir(path.join(tmpRoot, "packages", "api"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "packages", "web"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    const result = await buildRepoOverviewMarkdown({ workspaceRoot: tmpRoot });
    expect(result.markdown).toContain("## Subprojects");
    expect(result.markdown).toContain("packages/api");
  });

  it("truncates very large structure output", async () => {
    for (let i = 0; i < 250; i++) {
      await fs.mkdir(path.join(tmpRoot, `dir-${i}`), { recursive: true });
      await fs.writeFile(path.join(tmpRoot, `dir-${i}`, `nested-${i}.txt`), "x\n");
    }
    const result = await buildRepoOverviewMarkdown({
      workspaceRoot: tmpRoot,
      maxDepth: 1,
    });
    expect(result.markdown).toContain("overview truncated");
  });
});
