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
  getMemoryMdPath,
} from "@/lib/project-memory";
import { appendAutoMemoryIfEligible } from "@/lib/memory/auto-memory";

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

describe("auto-memory", () => {
  it("appends bullets to .atlarix/memory.md under an Auto Memory section", async () => {
    const ok = await appendAutoMemoryIfEligible({
      workspacePath: workspace,
      chatId: 42,
      toolsUsed: ["write_file"],
      summary: "Migrated auth from email/password to OAuth",
      confidence: 0.9,
      minConfidence: 0.5,
    });
    expect(ok).toBe(true);
    const body = await fs.readFile(getMemoryMdPath(workspace), "utf8");
    expect(body).toContain("## Auto Memory");
    expect(body).toContain("[chat 42] Migrated auth from email/password to OAuth");
  });

  it("preserves agent-authored knowledge above the section", async () => {
    await writeMemoryFile("# Project memory\n\nStack: Vue 3 + Vite\n");
    await appendAutoMemoryIfEligible({
      workspacePath: workspace,
      chatId: 7,
      toolsUsed: [],
      summary: "Swapped payments PayPal to Stripe",
      confidence: 1,
      minConfidence: 0.5,
    });
    const body = await fs.readFile(getMemoryMdPath(workspace), "utf8");
    expect(body).toContain("Stack: Vue 3 + Vite");
    expect(body.indexOf("Stack: Vue 3 + Vite")).toBeLessThan(
      body.indexOf("## Auto Memory"),
    );
  });

  it("survives a subsequent legacy migration intact", async () => {
    await appendAutoMemoryIfEligible({
      workspacePath: workspace,
      chatId: 1,
      toolsUsed: [],
      summary: "note",
      confidence: 1,
      minConfidence: 0,
    });
    await migrateLegacyAtlarixFiles(workspace);
    const body = await fs
      .readFile(getMemoryMdPath(workspace), "utf8")
      .catch(() => null);
    expect(body).toContain("[chat 1] note");
  });
});
