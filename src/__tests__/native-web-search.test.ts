/**
 * Provider-agnostic web-search dedup: a native web search (provider tool OR the
 * OpenRouter `web` plugin) supersedes the client `web_search`, so the model
 * never receives two tools with the same name (the xAI/Grok "Duplicate tool
 * names: web_search" bug). See reservedNativeToolNames / the dispatch dedup.
 */
import { afterEach, describe, it, expect } from "vitest";
import {
  getNativeWebSearchSupport,
  reservedNativeToolNames,
  type NativeWebSearchSupport,
} from "@/ipc/utils/native_web_search";
import {
  setCoreModelWebSearch,
  isCoreModelWebSearchEnabled,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";

/** Mirror of the dispatch-time dedup in chat_stream_handlers.simpleStreamText. */
function applyDedup(
  tools: Record<string, unknown>,
  support: NativeWebSearchSupport | null,
): Record<string, unknown> {
  if (!support) return tools;
  const reserved = new Set(reservedNativeToolNames(support));
  const out = Object.fromEntries(
    Object.entries(tools).filter(([name]) => !reserved.has(name)),
  );
  if (support.kind === "tool") out[support.key] = { __native: true };
  return out;
}

describe("reservedNativeToolNames", () => {
  it("openrouter plugin reserves the client web_search", () => {
    const support = getNativeWebSearchSupport("openrouter", "x-ai/grok-4");
    expect(support).toEqual({ kind: "openrouter-plugin" });
    expect(reservedNativeToolNames(support)).toEqual(["web_search"]);
  });

  it("a provider tool reserves both web_search and its own key", () => {
    const support = getNativeWebSearchSupport("anthropic", "claude-sonnet-4-5");
    expect(reservedNativeToolNames(support)).toContain("web_search");
    // anthropic's native tool key is also web_search → single reserved name
    expect(support?.kind).toBe("tool");
  });

  it("openai web_search_preview reserves both names", () => {
    const support = getNativeWebSearchSupport("openai", "gpt-5");
    expect(support?.kind).toBe("tool");
    const reserved = reservedNativeToolNames(support);
    expect(reserved).toContain("web_search");
    expect(reserved).toContain("web_search_preview");
  });

  it("no native support reserves nothing", () => {
    expect(reservedNativeToolNames(null)).toEqual([]);
    // ollama / unknown → client web_search stays
    expect(getNativeWebSearchSupport("ollama", "llama3")).toBeNull();
  });
});

describe("dispatch dedup leaves no duplicate web_search", () => {
  const baseTools = { web_search: { __client: true }, read_file: {}, grep: {} };

  it("xAI/Grok via OpenRouter: client web_search dropped, no duplicate", () => {
    const support = getNativeWebSearchSupport("openrouter", "x-ai/grok-4");
    const out = applyDedup(baseTools, support);
    expect(out.web_search).toBeUndefined(); // plugin provides it server-side
    expect(out.read_file).toBeDefined();
    expect(out.grep).toBeDefined();
  });

  it("anthropic: client web_search replaced by the native tool under the same key", () => {
    const support = getNativeWebSearchSupport("anthropic", "claude-sonnet-4-5");
    const out = applyDedup(baseTools, support) as Record<
      string,
      { __native?: boolean }
    >;
    expect(out.web_search).toEqual({ __native: true });
    // exactly one web_search entry — object keys are unique by construction
    expect(Object.keys(out).filter((k) => k === "web_search")).toHaveLength(1);
  });

  it("ollama (no native): client web_search stays", () => {
    const support = getNativeWebSearchSupport("ollama", "llama3");
    const out = applyDedup(baseTools, support);
    expect(out.web_search).toEqual({ __client: true });
  });
});

describe("Atlarix Core (compass) web search — client tool, no native path", () => {
  afterEach(() => __resetCoreModelOverridesForTests());

  /**
   * Core used to return OpenRouter's agentic `web_search` server tool. It no longer
   * routes through OpenRouter, and none of the four direct providers exposes agentic
   * search over a plain OpenAI-compatible chat endpoint — so Core drops to the client
   * SearxNG tool plus the in-app browser. A deliberate trade pending a proxy-side
   * paid search API.
   */
  it("returns null for every Core tier, so the client web_search tool is used", () => {
    for (const tier of ["core-1", "core-2", "core-3", "core-4"]) {
      expect(getNativeWebSearchSupport("compass", tier)).toBeNull();
    }
  });

  it("reserves NO tool name, so the client web_search is not stripped", () => {
    // The bug this guards: if Core reserved `web_search` while providing no native
    // tool, the client tool would be removed and Core would have no search at all.
    const support = getNativeWebSearchSupport("compass", "core-1");
    expect(reservedNativeToolNames(support)).toEqual([]);
  });

  it("ignores the legacy per-tier webSearch flag either way", () => {
    // The hosted flag is now inert for dispatch; it stays parsed for the follow-up
    // paid-search work, but must not resurrect a native path.
    setCoreModelWebSearch({ "core-1": true });
    expect(getNativeWebSearchSupport("compass", "core-1")).toBeNull();
    setCoreModelWebSearch({ "core-1": false });
    expect(getNativeWebSearchSupport("compass", "core-1")).toBeNull();
  });

  it("handles legacy tier aliases without throwing", () => {
    expect(getNativeWebSearchSupport("compass", "compass-fast")).toBeNull();
  });

  it("keeps the store helper working for the paid-search follow-up", () => {
    expect(isCoreModelWebSearchEnabled("core-3")).toBe(true);
    setCoreModelWebSearch({ "core-3": false });
    expect(isCoreModelWebSearchEnabled("core-3")).toBe(false);
    expect(isCoreModelWebSearchEnabled("core-4")).toBe(true);
  });
});
