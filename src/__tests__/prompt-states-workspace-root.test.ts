/**
 * The prompt must state the workspace root.
 *
 * It did not, and that was a missing FACT rather than a missing guard:
 * `tool_contract` tells the agent an absolute path is the only spelling that
 * reaches outside the workspace, while nothing anywhere gave it a root to build
 * one from. `workspacePath` reached `constructSystemPromptParts` and was used
 * only to load project instructions, build the docs hint, and derive `memoryDir`.
 *
 * Observed 2026-08-29: an agent in `/Users/…/Github/supabase-auth` spent six tool
 * calls against `/Users/…/Github/supabase-auth-jdv5y5`, a path it produced by
 * inverting the memory directory — `workspaceSlug()` renders the workspace path
 * with `/` → `-` and appends a hash, so the store name reads like a project path
 * with a suffix, and it was the only absolute path in the prompt naming the
 * project.
 *
 * Ordering is asserted deliberately: the root has to be readable BEFORE the
 * memory path, or the first project-shaped string the agent meets is still the
 * slug.
 */
import { describe, expect, it } from "vitest";

import { buildWorkstationIdentityBlock } from "@/lib/model-identity-prompt";

const WORKSPACE = "/Users/dev/Projects/supabase-auth";
const MEMORY =
  "/Users/dev/.atlarix/projects/Users-dev-Projects-supabase-auth-jdv5y5/memory";

const block = (over: Record<string, unknown> = {}) =>
  buildWorkstationIdentityBlock({
    modelDisplayName: "Test Model",
    providerBrand: "TestProvider",
    appVersion: "14.38.4",
    workspaceRoot: WORKSPACE,
    memoryDir: MEMORY,
    ...over,
  });

describe("runtime identity names the workspace root", () => {
  it("includes the absolute workspace path", () => {
    expect(block()).toContain(WORKSPACE);
  });

  it("states the root BEFORE the memory path", () => {
    const text = block();
    expect(text.indexOf(WORKSPACE)).toBeLessThan(text.indexOf(MEMORY));
  });

  it("omits the line entirely with no workspace — chat-only has no root", () => {
    const text = block({ workspaceRoot: undefined });
    expect(text).not.toContain("Workspace root");
    // The memory line is independent and must survive.
    expect(text).toContain(MEMORY);
  });

  it("carries no note count or other per-turn state — this is the cache prefix", () => {
    // Same constraint the memory path is held to: anything that changes between
    // turns churns the cached prompt prefix.
    expect(block()).not.toMatch(/\b\d+\s+notes?\b/i);
  });
});
