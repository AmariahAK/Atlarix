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
  readAtlarixMd,
  statMemoryMd,
  buildProjectDocsPromptHint,
  isWorkspaceMemoryMdPath,
  isWorkspaceAtlarixMdPath,
  isAtlarixDocWritePath,
  getAtlarixMdPath,
  readProjectInstructions,
  extractHeadings,
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
  await fs.writeFile(
    path.join(workspace, ".atlarix", "memory.md"),
    content,
    "utf8",
  );
}

describe("readAtlarixMd — case-insensitive, in place, never renamed (QA 2026-10-31)", () => {
  it("finds root ATLARIX.md (any casing) and leaves it untouched", async () => {
    await fs.writeFile(
      path.join(workspace, "ATLARIX.md"),
      "# rules\n\nuppercase root\n",
      "utf8",
    );
    expect(await readAtlarixMd(workspace)).toContain("uppercase root");
    // In place: still there, never renamed to .old, nothing copied into .atlarix/.
    expect(
      await fs.readFile(path.join(workspace, "ATLARIX.md"), "utf8"),
    ).toContain("uppercase root");
    await expect(fs.access(path.join(workspace, "ATLARIX.md.old"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(workspace, ".atlarix", "atlarix.md")),
    ).rejects.toThrow();
  });

  it("finds .atlarix/Atlarix.md (mixed case) in place", async () => {
    await fs.mkdir(path.join(workspace, ".atlarix"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".atlarix", "Atlarix.md"),
      "# rules\n\ndot mixed case\n",
      "utf8",
    );
    expect(await readAtlarixMd(workspace)).toContain("dot mixed case");
    await expect(
      fs.access(path.join(workspace, ".atlarix", "Atlarix.md.old")),
    ).rejects.toThrow();
  });

  it("reads both root and .atlarix/ together, root first", async () => {
    await fs.writeFile(path.join(workspace, "atlarix.md"), "ROOT-FIRST\n", "utf8");
    await fs.mkdir(path.join(workspace, ".atlarix"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".atlarix", "atlarix.md"),
      "DOT-SECOND\n",
      "utf8",
    );
    const content = await readAtlarixMd(workspace);
    expect(content).toContain("ROOT-FIRST");
    expect(content).toContain("DOT-SECOND");
    expect(content!.indexOf("ROOT-FIRST")).toBeLessThan(
      content!.indexOf("DOT-SECOND"),
    );
  });

  it("returns null when there is no instruction file", async () => {
    expect(await readAtlarixMd(workspace)).toBeNull();
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
  it("never injects a file body", async () => {
    await writeMemoryFile(
      "# Project memory\n\nSECRET-MARKER-CONTENT payments use Stripe.\n",
    );
    const hint = await buildProjectDocsPromptHint(workspace, {
      canWrite: true,
    });
    expect(hint).toContain("read_file");
    expect(hint).not.toContain("SECRET-MARKER-CONTENT");
  });

  it("always states the atlarix.md follow-when-non-empty rule", async () => {
    const hint = await buildProjectDocsPromptHint(workspace, {
      canWrite: false,
    });
    expect(hint).toContain(".atlarix/atlarix.md");
    expect(hint).toContain("absent or empty");
  });

  /**
   * v14.23.0: the `.atlarix/memory.md` paragraph is gone. That file is superseded by the
   * per-note store (`lib/agent-memory.ts`), whose index is surfaced by
   * `loadMemoryMdSection`. Still describing it here would point the model at a path that
   * is no longer the store — and, in a write-capable mode, invite it to WRITE there.
   */
  it("no longer advertises .atlarix/memory.md as the knowledge store", async () => {
    await writeMemoryFile("# Project memory\n\nstack notes\n");
    const hint = await buildProjectDocsPromptHint(workspace, {
      canWrite: true,
    });
    expect(hint).not.toContain("memory.md");
    expect(hint).not.toContain("you may create it");
    expect(hint).not.toContain("durable facts change");
  });

  it("is identical whether or not the mode can write — nothing to create any more", async () => {
    const writable = await buildProjectDocsPromptHint(workspace, {
      canWrite: true,
    });
    const readOnly = await buildProjectDocsPromptHint(workspace, {
      canWrite: false,
    });
    expect(writable).toBe(readOnly);
  });

  it("stays short — it is a rule statement, not a document", async () => {
    const hint = await buildProjectDocsPromptHint(workspace, {
      canWrite: true,
    });
    expect(hint.length).toBeLessThan(400);
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

  async function writeRule(name: string, content: string) {
    const dir = path.join(workspace, ".atlarix", "rules");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }

  /**
   * v14.45: `.atlarix/rules/` is the canonical home. Rules are plural — a project
   * accumulates them per concern — and one file forced a monolith or left the rest out
   * of the agent's reach.
   */
  describe(".atlarix/rules/", () => {
    it("wins over atlarix.md, and reports how many files it read", async () => {
      await writeAtlarix("from the old single file\n");
      await writeRule("testing.md", "# Testing\n\nalways red first\n");
      await writeRule("style.md", "# Style\n\ntabs\n");

      const res = await readProjectInstructions(workspace);
      expect(res?.source).toBe("rules");
      expect(res?.fileCount).toBe(2);
      expect(res?.content).toContain("always red first");
      expect(res?.content).toContain("tabs");
      expect(res?.content).not.toContain("from the old single file");
    });

    it("concatenates in filename order, deterministically", async () => {
      // The order rules reach the model is behaviour, so it must not depend on
      // readdir order or on the machine's locale.
      await writeRule("20-second.md", "SECOND");
      await writeRule("10-first.md", "FIRST");
      const res = await readProjectInstructions(workspace);
      expect(res!.content.indexOf("FIRST")).toBeLessThan(
        res!.content.indexOf("SECOND"),
      );
    });

    it("takes .md files only, and does not descend", async () => {
      await writeRule("real.md", "REAL");
      await writeRule("notes.txt", "IGNORED_TXT");
      await fs.mkdir(path.join(workspace, ".atlarix", "rules", "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workspace, ".atlarix", "rules", "nested", "deep.md"),
        "IGNORED_NESTED",
        "utf8",
      );

      const res = await readProjectInstructions(workspace);
      expect(res?.content).toContain("REAL");
      expect(res?.content).not.toContain("IGNORED_TXT");
      // Not recursive on purpose: nesting must not quietly change what is in scope.
      expect(res?.content).not.toContain("IGNORED_NESTED");
      expect(res?.fileCount).toBe(1);
    });

    it("an empty or whitespace-only directory falls through to the next rung", async () => {
      await writeAtlarix("the old file still applies\n");
      await writeRule("blank.md", "   \n\n  ");
      const res = await readProjectInstructions(workspace);
      expect(res?.source).toBe("atlarix");
      expect(res?.content).toContain("the old file still applies");
    });

    it("atlarix.md keeps working with no rules directory at all", async () => {
      // The rung is not a deprecation to tidy away later: every existing user has this
      // file, and removing it would delete their instructions silently.
      await writeAtlarix("still here\n");
      const res = await readProjectInstructions(workspace);
      expect(res?.source).toBe("atlarix");
      expect(res?.content).toContain("still here");
    });

    it("never creates the rules directory just by reading", async () => {
      await fs.writeFile(
        path.join(workspace, "AGENTS.md"),
        "agents wins\n",
        "utf8",
      );
      const res = await readProjectInstructions(workspace);
      expect(res?.source).toBe("agents");
      // `readAtlarixMd` mkdirs `.atlarix/` as a migration side effect; the rules rung
      // must not add a second one, or reading a workspace conjures a directory the
      // user never asked for.
      await expect(
        fs.stat(path.join(workspace, ".atlarix", "rules")),
      ).rejects.toThrow();
    });
  });

  it("prefers .atlarix/atlarix.md when present", async () => {
    await writeAtlarix("# Rules\n\nfrom atlarix\n");
    await fs.writeFile(
      path.join(workspace, "AGENTS.md"),
      "from agents\n",
      "utf8",
    );
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("atlarix");
    expect(res?.content).toContain("from atlarix");
  });

  it("falls back to AGENTS.md when atlarix.md is absent", async () => {
    await fs.writeFile(
      path.join(workspace, "AGENTS.md"),
      "agent guidance here\n",
      "utf8",
    );
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("agents");
    expect(res?.content).toContain("agent guidance here");
  });

  it("falls back to CLAUDE.md when atlarix.md and AGENTS.md are absent", async () => {
    await fs.writeFile(
      path.join(workspace, "CLAUDE.md"),
      "claude guidance\n",
      "utf8",
    );
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("claude");
    expect(res?.content).toContain("claude guidance");
  });

  it("treats a whitespace-only atlarix.md as absent and falls back", async () => {
    await writeAtlarix("   \n\n");
    await fs.writeFile(
      path.join(workspace, "AGENTS.md"),
      "real guidance\n",
      "utf8",
    );
    const res = await readProjectInstructions(workspace);
    expect(res?.source).toBe("agents");
  });

  it("returns null when no instructions file exists", async () => {
    expect(await readProjectInstructions(workspace)).toBeNull();
  });

  /**
   * v14.23.0 INVERTED this. It used to assert the 3000-char clamp; the clamp WAS the
   * bug — a longer instructions file had its tail silently dropped, so the user's later
   * rules never reached the model and nothing said so. Instructions are now pointed at
   * (see `loadAtlarixMdSection`) and read in full with `read_file`, so the reader must
   * return the file intact.
   */
  it("returns AGENTS.md in full — never truncated — and never copies it into .atlarix", async () => {
    const body = "x".repeat(5000);
    await fs.writeFile(path.join(workspace, "AGENTS.md"), body, "utf8");
    const res = await readProjectInstructions(workspace);
    expect(res?.content).toBe(body);
    expect(res?.content).not.toContain("...(truncated)");
    // Read-only fallback — atlarix.md is not created from AGENTS.md.
    const copied = await fs
      .access(getAtlarixMdPath(workspace))
      .then(() => true)
      .catch(() => false);
    expect(copied).toBe(false);
  });
});

describe("extractHeadings (the project-instructions pointer)", () => {
  it("pulls h1–h3 titles so a weak model can tell whether the rules apply", () => {
    const md = [
      "# Project rules",
      "some prose",
      "## Testing",
      "### Naming",
      "#### Too deep",
      "- not a heading",
    ].join("\n");
    expect(extractHeadings(md)).toEqual(["Project rules", "Testing", "Naming"]);
  });

  it("strips markdown emphasis from headings", () => {
    expect(extractHeadings("## **Build** `rules`")).toEqual(["Build rules"]);
  });

  it("caps the list — a file of headings must not re-bloat the prompt", () => {
    const md = Array.from({ length: 40 }, (_, i) => `## H${i}`).join("\n");
    expect(extractHeadings(md)).toHaveLength(12);
    expect(extractHeadings(md, 3)).toHaveLength(3);
  });

  it("returns nothing for a file with no headings", () => {
    expect(extractHeadings("just prose\nand more prose")).toEqual([]);
  });
});
