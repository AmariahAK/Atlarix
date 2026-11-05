/**
 * A compaction summary written on the turn's OWN request (token saving, owner
 * 2026-11-05; opencode does this, Codex keeps its tools for the same reason).
 *
 * The normal summariser sends its own system prompt and a flattened transcript,
 * so none of it is a cache hit: the whole conversation is paid for again at the
 * full input price just to be summarised. Here the request is exactly what the
 * turn sends (system header, history, cache markers, tools, provider options),
 * with one instruction appended, so the provider reads all of it from cache.
 *
 * Tools are sent so the cached prefix matches (their bytes are part of it), but
 * nothing can run: they carry no `execute`, and a reply that calls one instead
 * of summarising is treated as no summary, so the caller falls back to the
 * normal summariser. The model must be the turn's own, or nothing is cached.
 */
import { generateText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import log from "electron-log";
import { CONTEXT_COMPACTION_SYSTEM } from "@/prompts/context_compaction_prompt";
import { recordAuxUsage } from "@/lib/usage/turn-usage-aggregator";

const logger = log.scope("compaction");

/** Same ceiling as the normal summariser. */
const PREFIX_SUMMARY_MAX_OUTPUT_TOKENS = 8_000;

/**
 * Worded after opencode's (session/compaction.ts buildPrompt), the agent that
 * also summarises on its cached request, and Codex's "handoff summary for
 * another LLM": summarise the conversation, not the setup in front of it
 * (here that is the whole system header, re-sent fresh anyway), and leave out
 * what the next agent can recover: in Atlarix also with session_search.
 */
export const PREFIX_SUMMARY_INSTRUCTION = `${CONTEXT_COMPACTION_SYSTEM}

Summarize the conversation above into that structure, for another agent that will resume the work. Summarize only what the user and the assistant said and did: leave out the instructions and setup the assistant was given (system rules, project instructions, tool descriptions); the next agent receives current versions of those separately. Leave out details the next agent can recover from the files or with session_search. Do not continue the task or call tools. Return only the summary, with no preamble.`;

export async function summarizeOnTurnPrefix(args: {
  model: LanguageModel;
  /** The messages this step would send: header, history and steps, with their cache markers. */
  messages: ModelMessage[];
  tools?: ToolSet;
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string>;
  maxRetries?: number;
  chatId?: number;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const tools = args.tools
    ? (Object.fromEntries(
        Object.entries(args.tools).map(([name, t]) => [name, { ...(t as object), execute: undefined }]),
      ) as ToolSet)
    : undefined;
  try {
    const result = await generateText({
      model: args.model,
      allowSystemInMessages: true,
      messages: [...args.messages, { role: "user", content: PREFIX_SUMMARY_INSTRUCTION }],
      ...(tools ? { tools } : {}),
      ...(args.providerOptions ? { providerOptions: args.providerOptions as never } : {}),
      ...(args.headers ? { headers: args.headers } : {}),
      maxOutputTokens: PREFIX_SUMMARY_MAX_OUTPUT_TOKENS,
      ...(args.maxRetries != null ? { maxRetries: args.maxRetries } : {}),
      ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    });
    recordAuxUsage(args.chatId, result.usage, "compaction");
    const usage = result.usage as { inputTokens?: number; cachedInputTokens?: number } | undefined;
    logger.log(
      `[compaction] summary on the turn's prefix: input=${usage?.inputTokens ?? "?"} cached=${usage?.cachedInputTokens ?? "?"} toolCalls=${result.toolCalls?.length ?? 0}`,
    );
    if ((result.toolCalls?.length ?? 0) > 0) return null;
    const text = result.text.trim();
    return text || null;
  } catch (error) {
    logger.warn("[compaction] summary on the turn's prefix failed; using the normal summariser:", error);
    return null;
  }
}
