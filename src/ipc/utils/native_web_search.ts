/**
 * Provider-native web search (v10.1)
 * ==================================
 * When the active model's provider ships a built-in web-search tool, Atlarix
 * passes that tool at dispatch instead of the client-side `web_search`
 * implementation — provider-grade results + citations, no SearxNG needed.
 *
 * Chain: provider-native → client `web_search` (SearxNG → public SearxNG →
 * DDG) → search MCPs. The client tool stays the universal fallback for
 * providers without native search (Ollama, LM Studio, Groq, …).
 */

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { openrouter } from "@openrouter/ai-sdk-provider";
import type { Tool } from "ai";
import { normalizeCoreTierId } from "@/ipc/shared/compass_constants";
import { isCoreModelWebSearchEnabled } from "@/ipc/shared/core-model-override-store";

export type NativeWebSearchSupport =
  | {
      kind: "tool";
      /** Tool-map key (also the toolName seen in stream parts / citations). */
      key: string;
      tool: Tool;
    }
  | {
      /** OpenRouter web plugin — merged into providerOptions, no tool entry. */
      kind: "openrouter-plugin";
    };

/**
 * Detect native web-search support for the resolved provider + model.
 * Conservative model gates: an unsupported combination would hard-fail the
 * stream (there is no per-request fallback once dispatched).
 */
export function getNativeWebSearchSupport(
  builtinProviderId: string | undefined,
  modelName: string | undefined,
): NativeWebSearchSupport | null {
  const model = (modelName ?? "").toLowerCase();
  switch (builtinProviderId) {
    case "anthropic":
      return {
        kind: "tool",
        key: "web_search",
        tool: anthropic.tools.webSearch_20250305({ maxUses: 5 }) as Tool,
      };
    case "openai":
      // Responses API web search (Atlarix already dispatches via provider.responses()).
      if (/^gpt-4o|^gpt-4\.1|^gpt-5/.test(model)) {
        return {
          kind: "tool",
          key: "web_search_preview",
          tool: openai.tools.webSearchPreview({
            searchContextSize: "medium",
          }) as Tool,
        };
      }
      return null;
    case "google":
      // Grounding can be combined with function tools on Gemini 2+ only.
      if (/gemini-[2-9]/.test(model)) {
        return {
          kind: "tool",
          key: "google_search",
          tool: google.tools.googleSearch({}) as Tool,
        };
      }
      return null;
    case "openrouter":
      // BYOK OpenRouter: the always-on `web` plugin adds search results
      // server-side (billed per request against the user's own key).
      return { kind: "openrouter-plugin" };
    case "compass": {
      // Atlarix Core routes through the same OpenRouter provider (via the proxy),
      // so it uses the AGENTIC `openrouter:web_search` server tool: the MODEL
      // decides when to search (0–N times/turn — pay-per-use, unlike the always-on
      // plugin), and the proxy meters the real per-search cost through the wallet
      // at the standard markup. Gated per Core tier via the hosted catalog — a tier
      // that under-invokes the tool is set `false` and drops to the client
      // `web_search` (SearxNG) fallback (returns null here).
      const tier = normalizeCoreTierId(modelName ?? "");
      if (!isCoreModelWebSearchEnabled(tier)) return null;
      return {
        kind: "tool",
        key: "web_search",
        tool: openrouter.tools.webSearch({ maxResults: 5 }) as Tool,
      };
    }
    default:
      return null;
  }
}

/**
 * Provider-agnostic dedup: the client tool name(s) a native web search
 * supersedes and that MUST be dropped from the dispatched tool set, so the
 * model never receives two tools with the same name. Covers every provider
 * uniformly — the OpenRouter `web` plugin injects a `web_search` server-side
 * (outside our tool object), Anthropic exposes `web_search`, etc. Keyed off the
 * active native support, never off a provider id.
 */
export function reservedNativeToolNames(
  support: NativeWebSearchSupport | null,
): string[] {
  if (!support) return [];
  // The client `web_search` is always superseded by any native web search.
  const names = ["web_search"];
  // A provider tool also occupies its own key (e.g. web_search_preview,
  // google_search) — reserve it too so a same-named client tool can't collide.
  if (support.kind === "tool") names.push(support.key);
  return names;
}

