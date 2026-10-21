/**
 * A workspace with NO notes is still told where notes go.
 *
 * That guarantee is the fix for the two-directory bug, and it has NOT changed — only
 * where it is delivered. The original failure: `loadMemoryMdSection` was "the only
 * place the absolute memory path is published" and bailed on an empty store, while
 * `src/skills/guides/memory.md` told the agent the directory was "shown in your
 * context". So a fresh workspace said nothing, the skill pointed at nothing, and the
 * agent invented `~/.atlarix/projects/<basename>/memory/` — the obvious
 * human-readable guess. Notes landed outside the store, which kept the store empty,
 * which kept the section hidden, so the FIRST note could never reach the right place;
 * and every attempt raised a sandbox prompt, the guessed path being outside the grant.
 *
 * The path is now published in the RUNTIME IDENTITY block, at character 0 of the
 * system prompt, for every workspace turn whether or not any note exists. That is
 * strictly stronger than the empty-state section it replaces: unconditional, in the
 * cache-stable header, and read before the agent has decided anything. So the
 * empty-state section is gone, and its cost on every turn of every empty workspace
 * goes with it.
 *
 * These tests therefore assert the GUARANTEE (the absolute path is published, never a
 * guess, never a placeholder) rather than the mechanism that used to carry it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildMemoryTurnContext } from "@/lib/memory/session-context";
import { buildWorkstationIdentityBlock } from "@/lib/model-identity-prompt";
import {
  appendIndexLine,
  memoryDirFor,
  setAgentMemoryRootOverride,
} from "@/lib/agent-memory";

let root = "";
let workspace = "";

function firstMessage() {
  return buildMemoryTurnContext({
    workspacePath: workspace,
    scope: null,
    history: [],
    userText: "hello",
    select: async () => [],
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-empty-root-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-empty-ws-"));
  setAgentMemoryRootOverride(root);
  delete process.env.ATLARIX_MEMORY;
});

afterEach(async () => {
  setAgentMemoryRootOverride(null);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("memory location on an empty store", () => {
  const identity = () =>
    buildWorkstationIdentityBlock({
      modelDisplayName: "Test Model",
      providerBrand: "test",
      appVersion: "0.0.0",
      memoryDir: memoryDirFor(workspace),
    });

  it("names the ABSOLUTE directory, so the first note has somewhere correct to go", () => {
    expect(identity()).toContain(memoryDirFor(workspace));
  });

  it("does not leave the agent to guess the human-readable path", () => {
    // The exact directory the agent invented on a real machine. It must not be what
    // the prompt implies, and the published path must not merely be a placeholder.
    const guessed = path.join(
      root,
      "projects",
      path.basename(workspace),
      "memory",
    );
    const text = identity();
    expect(text).not.toContain(guessed);
    expect(text).not.toContain("<slug>");
    expect(text).not.toContain("<basename>");
  });

  it("costs NOTHING per message while the store is empty", async () => {
    // The old empty-state section rendered on every turn just to name the directory,
    // and had to be policed for size. Now the directory is named once in the cached
    // header, so a message carries nothing at all on an empty store.
    expect(await firstMessage()).toBe("");
  });

  it("states a LOCATION without creating an obligation to write notes", () => {
    // The empty-state section carried the "optional" framing; the identity line
    // replaces it, so it must not read as an instruction to start recording things.
    // A note must never displace the user's task.
    const text = identity();
    expect(text).not.toMatch(/\byou must\b/i);
    expect(text).not.toMatch(/\balways (record|write|save)\b/i);
    expect(text).not.toMatch(/\bremember to\b/i);
  });

  it("hands over to the index reminder as soon as a note exists", async () => {
    const dir = memoryDirFor(workspace);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "thing.md"), "# thing\n", "utf8");
    await appendIndexLine(workspace, "- [Thing](thing.md) — a hook");

    const text = await firstMessage();
    expect(text).toContain("- [Thing](thing.md) — a hook");
    expect(text).toContain(`Contents of ${path.join(dir, "MEMORY.md")}`);
  });

  it("still renders nothing when memory is switched off entirely", async () => {
    // ATLARIX_MEMORY=off must remove the surface completely, empty store included —
    // benchmark runs carry no memory surface at all.
    process.env.ATLARIX_MEMORY = "off";
    expect(await firstMessage()).toBe("");
  });
});
