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
    const out = applyDedup(baseTools, support) as Record<string, { __native?: boolean }>;
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

describe("Atlarix Core (compass) web search — agentic server tool, per-tier gated", () => {
  afterEach(() => __resetCoreModelOverridesForTests());

  it("defaults ON: a Core tier gets the OpenRouter web_search server tool", () => {
    const support = getNativeWebSearchSupport("compass", "core-1");
    expect(support?.kind).toBe("tool");
    expect(support && support.kind === "tool" && support.key).toBe("web_search");
    // it supersedes the client web_search (same key → deduped to one entry)
    expect(reservedNativeToolNames(support)).toContain("web_search");
    expect(new Set(reservedNativeToolNames(support))).toEqual(new Set(["web_search"]));
  });

  it("a tier explicitly disabled in the catalog falls back to null (client SearxNG tool)", () => {
    setCoreModelWebSearch({ "core-1": false });
    expect(getNativeWebSearchSupport("compass", "core-1")).toBeNull();
    // other tiers stay on the server tool
    expect(getNativeWebSearchSupport("compass", "core-2")?.kind).toBe("tool");
  });

  it("legacy tier alias normalizes before the gate check", () => {
    setCoreModelWebSearch({ "core-1": false }); // compass-fast → core-1
    expect(getNativeWebSearchSupport("compass", "compass-fast")).toBeNull();
  });

  it("isCoreModelWebSearchEnabled defaults true, false only when set", () => {
    expect(isCoreModelWebSearchEnabled("core-3")).toBe(true);
    setCoreModelWebSearch({ "core-3": false });
    expect(isCoreModelWebSearchEnabled("core-3")).toBe(false);
    expect(isCoreModelWebSearchEnabled("core-4")).toBe(true);
  });
});
