/**
 * Provider-native web search (v10.1)
 * ==================================
 * When the active model's provider ships a built-in web-search tool, Atlarix
 * passes that tool at dispatch instead of the client-side `web_search`
 * implementation — provider-grade results + citations.
 *
 * Chain: provider-native → client `web_search` (Atlarix's own Chromium →
 * self-hosted SearxNG → DDG) → search MCPs. The client tool stays the universal
 * fallback for providers without native search (Ollama, LM Studio, Groq, … and
 * now Core), and since v14.35.0 its top tier is a real browser, so "no native
 * search" is no longer the same as "no good search".
 *
 * Atlarix Core is deliberately NOT in the native list any more: it routes to the
 * four provider clouds directly, and none of them offers agentic search over a
 * plain OpenAI-compatible chat endpoint. See the `compass` case.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { Tool } from "ai";

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
    case "compass":
      // Core no longer routes through OpenRouter, so OpenRouter's agentic
      // `web_search` server tool is not available to it — and none of the four
      // direct providers exposes an equivalent through a plain OpenAI-compatible
      // chat endpoint (DeepSeek's is Anthropic-protocol only, Qwen's needs
      // DashScope-native calls, Moonshot's is explicitly not production-ready,
      // MiniMax has none).
      //
      // Returning null drops Core to the client `web_search` tool, which is no
      // longer a downgrade: its top tier runs the query through Atlarix's own
      // Chromium (`lib/search/browser-search.ts`). Measured 2026-08-19 on the same
      // three developer queries, that tier returned 24 / 29 / 25 results where the
      // DDG Instant API and all five public SearxNG instances returned 0 — the
      // failures below it are all "is this a real browser?" checks, and a real
      // browser is what Atlarix ships.
      return null;
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

