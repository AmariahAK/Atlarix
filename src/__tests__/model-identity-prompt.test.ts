import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildWorkstationIdentityBlock,
  formatModelApiNameForDisplay,
  providerBrandName,
  resolveActiveModelIdentity,
} from "@/lib/model-identity-prompt";
import { constructSystemPromptParts } from "@/prompts/system_prompt";

describe("model-identity-prompt", () => {
  beforeEach(() => {
    vi.stubEnv("ATLARIX_CORE_MODEL_1", "deepseek/deepseek-v4-flash");
    vi.stubEnv("ATLARIX_CORE_MODEL_2", "deepseek/deepseek-v4-pro");
    vi.stubEnv("ATLARIX_CORE_MODEL_3", "moonshotai/kimi-k2.6");
    vi.stubEnv("ATLARIX_CORE_MODEL_4", "anthropic/claude-opus-4");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("formats DeepSeek-style api names for display", () => {
    expect(formatModelApiNameForDisplay("deepseek/deepseek-v3")).toContain(
      "DeepSeek",
    );
  });

  it("maps provider ids to brand names", () => {
    expect(providerBrandName("anthropic")).toBe("Anthropic");
    expect(providerBrandName("openrouter")).toBe("OpenRouter");
  });

  it("builds workstation block with separate NorahLabs and Atlarix links", () => {
    const block = buildWorkstationIdentityBlock({
      modelDisplayName: "DeepSeek V4 Pro",
      providerBrand: "deepseek",
      labelWithProvider: "DeepSeek V4 Pro (deepseek)",
      appVersion: "8.7.0",
    });
    expect(block).toMatch(/agent workstation/i);
    expect(block).toMatch(/norahlabs\.com/);
    expect(block).toMatch(/atlarix\.dev/);
    expect(block).toMatch(/DeepSeek V4 Pro \(deepseek\)/);
    expect(block).not.toMatch(/You are \*\*Atlarix AI\*\*/);
    expect(block).not.toMatch(/You are \*\*Compass/i);
  });

  it("maps Core tier to routed model identity (legacy id included)", () => {
    const id = resolveActiveModelIdentity({
      provider: "compass",
      name: "core-2",
    });
    expect(id.providerBrand).toBe("deepseek");
    expect(id.labelWithProvider).toMatch(/\(deepseek\)/);
    expect(id.modelDisplayName).toMatch(/DeepSeek|Pro/i);
    expect(id.modelDisplayName).not.toMatch(/Compass/i);

    const legacy = resolveActiveModelIdentity({
      provider: "compass",
      name: "compass-balanced",
    });
    expect(legacy.labelWithProvider).toBe(id.labelWithProvider);
  });

  it("resolveActiveModelIdentity uses routed model", () => {
    const id = resolveActiveModelIdentity({
      provider: "anthropic",
      name: "claude-sonnet-4-20250514",
    });
    expect(id.providerBrand).toBe("anthropic");
    expect(id.modelDisplayName.length).toBeGreaterThan(0);
  });

  it("constructSystemPromptParts includes workstation identity when activeModel set", () => {
    const { stableHeader } = constructSystemPromptParts({
      activeModel: { provider: "anthropic", name: "claude-sonnet-4" },
    });
    expect(stableHeader).toMatch(/running inside \*\*Atlarix\*\*/);
    expect(stableHeader).not.toMatch(/in-app assistant for \*\*Atlarix\*\*/);
  });
});

/**
 * The memory store's location is published HERE, at the top beside the model name,
 * and not only in a mid-prompt context section.
 *
 * Why it moved: a model spent ~15 tool calls running `find` for MEMORY.md and then
 * answered from a stale hand-made copy — with the resolved path in its context the
 * whole time, just further down. Position is the fix; the wording only has to make
 * searching for an alternative obviously wrong.
 */
describe("memory location in the runtime identity block", () => {
  const MEM =
    "/Users/x/.atlarix/projects/Users-x-Documents-wisdom-drop-1upmb8f/memory";

  const block = (memoryDir?: string) =>
    buildWorkstationIdentityBlock({
      modelDisplayName: "DeepSeek V4 Pro",
      providerBrand: "deepseek",
      appVersion: "14.35.0",
      memoryDir,
    });

  it("states the resolved absolute path", () => {
    expect(block(MEM)).toContain(MEM);
  });

  it("says it is the ONLY store and not to go looking", () => {
    // Load-bearing, not decoration: the incident was a second, staler copy winning
    // a `find`. Naming the path without ruling out alternatives is what failed.
    const text = block(MEM);
    expect(text).toMatch(/only store/i);
    expect(text).toMatch(/nowhere else/i);
    expect(text).toMatch(/do not search/i);
  });

  it("publishes NO path when there is no workspace", () => {
    // Chat-only has no per-workspace store, and a path that does not exist is worse
    // than none — it is a location to invent notes into.
    const text = block(undefined);
    expect(text).not.toMatch(/Project memory/);
    expect(text).not.toMatch(/\.atlarix/);
  });

  /**
   * The cache constraint. This block is part of `stableHeader`, the prompt-cache
   * prefix — the same reason `freemem()` is kept out of the device line while cores
   * and total RAM stay in. The path is stable per workspace; the note COUNT changes
   * on every note written, so it must never appear here.
   */
  it("carries the path only — never a note count", () => {
    const text = block(MEM);
    expect(text).not.toMatch(/\bnote\(s\)/);
    expect(text).not.toMatch(/\b\d+ notes?\b/);
  });

  it("is byte-identical across calls, so it cannot churn the cache prefix", () => {
    expect(block(MEM)).toBe(block(MEM));
  });

  it("reaches the assembled stableHeader, not just the block", () => {
    const { stableHeader, dynamicTail } = constructSystemPromptParts({
      activeModel: { provider: "deepseek", name: "deepseek-v4-pro" },
      memoryDir: MEM,
    });
    // The move that matters: it is in the CACHE-STABLE header, ahead of every
    // per-turn section, instead of in the dynamic tail where it was being read too
    // late to stop the agent going looking.
    expect(stableHeader).toContain(MEM);
    expect(dynamicTail).not.toContain(MEM);
  });

  it("sits inside the Runtime identity section", () => {
    const { stableHeader } = constructSystemPromptParts({
      activeModel: { provider: "deepseek", name: "deepseek-v4-pro" },
      memoryDir: MEM,
    });
    const identityAt = stableHeader.indexOf("# Runtime identity");
    const memoryAt = stableHeader.indexOf(MEM);
    expect(identityAt).toBeGreaterThan(-1);
    expect(memoryAt).toBeGreaterThan(identityAt);
    // Adjacent to the model name, which is the whole point of putting it here.
    expect(memoryAt - identityAt).toBeLessThan(1200);
  });

  /**
   * Identity is the FIRST thing in the header, and the memory line rides with it.
   *
   * Measured before this landed: the identity block sat fifth, putting the memory
   * path 94% of the way through a 14k-character header — orienting information
   * after all the procedure. It is now at character 0. A future reorder that
   * pushes it back down would silently undo the whole point of the change, and
   * nothing else would fail.
   */
  it("opens the header, so the path is read before anything is decided", () => {
    const { stableHeader } = constructSystemPromptParts({
      activeModel: { provider: "deepseek", name: "deepseek-v4-pro" },
      memoryDir: MEM,
    });
    expect(stableHeader.startsWith("# Runtime identity")).toBe(true);
    // Well inside the opening section rather than merely "somewhere earlier".
    expect(stableHeader.indexOf(MEM)).toBeLessThan(1500);
    // And still ahead of the procedural blocks.
    expect(stableHeader.indexOf(MEM)).toBeLessThan(
      stableHeader.indexOf("<tool_contract>"),
    );
  });

  it("is omitted entirely in headless runs", () => {
    // Headless drops the identity block by design (it is app context, irrelevant to
    // a benchmark task), so the memory line goes with it rather than leaking into a
    // prompt that has no user and no store.
    vi.stubEnv("ATLARIX_HEADLESS", "1");
    try {
      const { stableHeader } = constructSystemPromptParts({
        activeModel: { provider: "deepseek", name: "deepseek-v4-pro" },
        memoryDir: MEM,
      });
      expect(stableHeader).not.toContain(MEM);
      expect(stableHeader).not.toContain("# Runtime identity");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
