import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The CLI runs in the USER's repository, and repositories commonly carry an
 * AGENTS.md of their own. Observed in the compiled CLI: a 21-byte AGENTS.md in
 * the working folder became Atlarix's ENTIRE system guidance, because every
 * lookup candidate (cwd, and `app.getAppPath()`, which the headless electron
 * stub answers with cwd) resolved into that folder. When the build names its
 * own copy, only that copy may be read.
 */
describe("AGENTS.md: the shipped copy wins over the working folder", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    delete process.env.ATLARIX_AGENTS_FILE;
    vi.resetModules();
  });

  it("reads ATLARIX_AGENTS_FILE and never the repo's AGENTS.md", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-md-"));
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "USER REPO FILE");
    const shipped = path.join(dir, "shipped-AGENTS.md");
    fs.writeFileSync(shipped, "# Atlarix shipped guidance");
    process.chdir(dir);
    process.env.ATLARIX_AGENTS_FILE = shipped;
    vi.resetModules();

    const { getAgentsMdForWorkMode } = await import("@/prompts/system_prompt");
    const text = getAgentsMdForWorkMode("build" as never);
    expect(text).toContain("Atlarix shipped guidance");
    expect(text).not.toContain("USER REPO FILE");
  });
});
