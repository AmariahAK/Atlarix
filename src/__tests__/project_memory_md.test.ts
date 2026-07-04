/**
 * v10: `.atlarix/memory.md` is a first-class agent-maintained knowledge file —
 * never archived by the legacy migration, never injected into the prompt
 * (hint-only), and writable in Plan mode alongside atlarix.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  migrateLegacyAtlarixFiles,
  statMemoryMd,
  buildProjectDocsPromptHint,
  isWorkspaceMemoryMdPath,
  isWorkspaceAtlarixMdPath,
  isAtlarixDocWritePath,
  getAtlarixMdPath,
  readProjectInstructions,
} from "@/lib/project-memory";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-memory-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeMemoryFile(content: string) {
  await fs.mkdir(path.join(workspace, ".atlarix"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".atlarix", "memory.md"), content, "utf8");
}

describe("migrateLegacyAtlarixFiles", () => {
  it("does NOT archive .atlarix/memory.md (first-class file)", async () => {
    await writeMemoryFile("# Project memory\n\nStack: TypeScript + Electron\n");
    await migrateLegacyAtlarixFiles(workspace);
    const stillThere = await fs
      .readFile(path.join(workspace, ".atlarix", "memory.md"), "utf8")
      .catch(() => null);
    expect(stillThere).toContain("Stack: TypeScript + Electron");
    const archived = await fs
      .access(path.join(workspace, ".atlarix", "memory.md.old"))
      .then(() => true)
      .catch(() => false);
    expect(archived).toBe(false);
  });

  it("does not touch a root MEMORY.md", async () => {
    await fs.writeFile(path.join(workspace, "MEMORY.md"), "user file\n", "utf8");
    await migrateLegacyAtlarixFiles(workspace);
    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf8");
    expect(content).toBe("user file\n");
  });

  it("still folds legacy .atlarix/ATLARIX.md into atlarix.md", async () => {
    await fs.mkdir(path.join(workspace, ".atlarix"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".atlarix", "ATLARIX.md"),
      "# Rules\n\nlegacy instructions\n",
      "utf8",
    );
    await migrateLegacyAtlarixFiles(workspace);
    const canonical = await fs.readFile(
      path.join(workspace, ".atlarix", "atlarix.md"),
      "utf8",
    );
    expect(canonical).toContain("legacy instructions");
  });
});

describe("statMemoryMd", () => {
  it("returns null when missing or empty", async () => {
    expect(await statMemoryMd(workspace)).toBeNull();
    await writeMemoryFile("");
    expect(await statMemoryMd(workspace)).toBeNull();
  });

  it("returns size + ISO date when present", async () => {
    await writeMemoryFile("# Project memory\n\nNext.js 15, Supabase auth.\n");
    const stat = await statMemoryMd(workspace);
    expect(stat).not.toBeNull();
    expect(stat!.exists).toBe(true);
    expect(stat!.sizeKb).toBeGreaterThanOrEqual(1);
    expect(stat!.modified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildProjectDocsPromptHint", () => {
  it("never injects the memory.md body (hint-only)", async () => {
    await writeMemoryFile(
      "# Project memory\n\nSECRET-MARKER-CONTENT payments use Stripe.\n",
    );
    const hint = await buildProjectDocsPromptHint(workspace, { canWrite: true });
    expect(hint).toContain(".atlarix/memory.md");
    expect(hint).toContain("read_file");
    expect(hint).not.toContain("SECRET-MARKER-CONTENT");
  });

  it("suggests creating the file only in write-capable modes", async () => {
    const writable = await buildProjectDocsPromptHint(workspace, { canWrite: true });
    expect(writable).toContain("you may create it");
    const readOnly = await buildProjectDocsPromptHint(workspace, { canWrite: false });
    expect(readOnly).not.toContain("you may create it");
  });

  it("always states the atlarix.md follow-when-non-empty rule", async () => {
    const hint = await buildProjectDocsPromptHint(workspace, { canWrite: false });
    expect(hint).toContain(".atlarix/atlarix.md");
    expect(hint).toContain("absent or empty");
  });

  it("mentions updating on durable changes when the file exists", async () => {
    await writeMemoryFile("# Project memory\n\nstack notes\n");
    const hint = await buildProjectDocsPromptHint(workspace, { canWrite: true });
    expect(hint).toContain("durable facts change");
  });
});

describe("path gates", () => {
  it("isWorkspaceMemoryMdPath accepts only memory.md paths", () => {
    expect(isWorkspaceMemoryMdPath(".atlarix/memory.md")).toBe(true);
    expect(isWorkspaceMemoryMdPath("memory.md")).toBe(true);
    expect(isWorkspaceMemoryMdPath(".atlarix\\memory.md")).toBe(true);
    expect(isWorkspaceMemoryMdPath("src/memory.md")).toBe(false);
    expect(isWorkspaceMemoryMdPath(".atlarix/atlarix.md")).toBe(false);
  });

  it("isAtlarixDocWritePath covers both docs and nothing else", () => {
    expect(isAtlarixDocWritePath(".atlarix/atlarix.md")).toBe(true);
    expect(isAtlarixDocWritePath(".atlarix/memory.md")).toBe(true);
    expect(isAtlarixDocWritePath("src/index.ts")).toBe(false);
    expect(isAtlarixDocWritePath(".atlarix/plans/plan.md")).toBe(false);
  });

  it("isWorkspaceAtlarixMdPath unchanged for atlarix.md", () => {
    expect(isWorkspaceAtlarixMdPath(".atlarix/atlarix.md")).toBe(true);
    expect(isWorkspaceAtlarixMdPath(".atlarix/memory.md")).toBe(false);
  });
});

describe("readProjectInstructions (v13.1 AGENTS.md/CLAUDE.md interop)", () => {
  async function writeAtlarix(content: string) {
    await fs.mkdir(path.join(workspace, ".atlarix"), { recursive: true });
    await fs.writeFile(getAtlarixMdPath(workspace), content, "utf8");
  }

  it("prefers .atlarix/atlarix.md when present", async () => {
    await writeAtlarix("# Rules\n\nfrom atlarix\n");
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "from agents\n", "utf8");
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("atlarix");
    expect(res?.content).toContain("from atlarix");
  });

  it("falls back to AGENTS.md when atlarix.md is absent", async () => {
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "agent guidance here\n", "utf8");
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("agents");
    expect(res?.content).toContain("agent guidance here");
  });

  it("falls back to CLAUDE.md when atlarix.md and AGENTS.md are absent", async () => {
    await fs.writeFile(path.join(workspace, "CLAUDE.md"), "claude guidance\n", "utf8");
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("claude");
    expect(res?.content).toContain("claude guidance");
  });

  it("treats a whitespace-only atlarix.md as absent and falls back", async () => {
    await writeAtlarix("   \n\n");
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "real guidance\n", "utf8");
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("agents");
  });

  it("returns null when no instructions file exists", async () => {
    expect(await readProjectInstructions(workspace)).toBeNull();
  });

  it("caps AGENTS.md to the inject budget and never copies it into .atlarix", async () => {
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "x".repeat(5000), "utf8");
    const res = await readProjectInstructions(workspace);
    expect(res?.content).toContain("...(truncated)");
    expect(res!.content.length).toBeLessThan(5000);
    // Read-only fallback — atlarix.md is not created from AGENTS.md.
    const copied = await fs
      .access(getAtlarixMdPath(workspace))
      .then(() => true)
      .catch(() => false);
    expect(copied).toBe(false);
  });
});

