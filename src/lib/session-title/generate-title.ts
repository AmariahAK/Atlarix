/**
 * Session titles — the MODEL half: which model names a session, and the call.
 *
 * MODEL CHAIN (the reference tools' pattern — opencode's `small_model`, Codex's
 * dedicated small model, Claude Code's background Haiku):
 *   1. a custom summarization model, if the user picked one;
 *   2. Core: Atlarix Auto stays on Auto (its proxy routes `purpose:"title"` to
 *      the cheapest lane); a fixed paid tier uses the cheapest paid tier —
 *      never free Auto, whose prompts are shared;
 *   3. BYOK: the cheapest small model (flash / nano / mini / haiku / lite) the
 *      catalog lists on the user's OWN provider;
 *   4. otherwise the selected model.
 * A BYOK user's prompt NEVER reaches Core: a client that silently fell back to
 * Core is refused here rather than used.
 *
 * CALL SETTINGS. Reasoning off where the catalog says the model reasons (a
 * reasoning model can spend any cap on thinking and return nothing — the
 * extension measured exactly that with a 32-token cap), a GENEROUS output cap
 * that only stops a runaway, a timeout, and one retry — the retry drops the
 * reasoning option, because a provider that rejects `reasoning:"none"` (older
 * OpenAI o-series) is the likeliest first failure.
 */

import log from "electron-log";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import {
  looksLikeReplyNotTitle,
  sanitizeGeneratedTitle,
  TITLE_SYSTEM_PROMPT,
  titleUserPrompt,
} from "./title-text";

const logger = log.scope("session-title");

/** Runaway insurance only — a title is a few tokens. */
const TITLE_MAX_OUTPUT_TOKENS = 1_024;
const TITLE_TIMEOUT_MS = 15_000;

const SMALL_FAMILY_RE = /\b(flash|nano|mini|haiku|lite|small)\b/i;
/** Small-named models that cannot write a text title. */
const NOT_A_CHAT_MODEL_RE =
  /\b(image|tts|audio|realtime|transcribe|embed|embedding|vision-only|search)\b/i;

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

/** The cheapest small text model on `provider`, from the models.dev catalog. */
export async function pickSmallSibling(
  provider: string,
): Promise<LargeLanguageModel | null> {
  try {
    const { getModelsDevCatalogRows } = await import("@/lib/models_dev");
    const rows = await getModelsDevCatalogRows(provider, {
      requireToolCall: false,
    });
    const costOf = (m: (typeof rows)[number]) =>
      "cost" in m
        ? (m.cost as { input?: number; output?: number } | undefined)
        : undefined;
    const candidates = rows.filter((m) => {
      const label = `${m.apiName} ${m.displayName ?? ""} ${m.description ?? ""}`;
      return (
        SMALL_FAMILY_RE.test(label) &&
        !NOT_A_CHAT_MODEL_RE.test(label) &&
        costOf(m) != null
      );
    });
    // No small model on this provider → the caller uses the SELECTED model.
    if (candidates.length === 0) return null;
    const price = (m: (typeof candidates)[number]) =>
      (costOf(m)?.input ?? 0) + (costOf(m)?.output ?? 0);
    candidates.sort((a, b) => price(a) - price(b));
    return { provider, name: candidates[0]!.apiName };
  } catch (err) {
    logger.warn("title: small-model lookup failed", err);
    return null;
  }
}

/**
 * `turnModel` is the session's own model (a CLI, editor or user-agent session):
 * its title comes from that provider, not from the app's choice, which may be
 * one it never picked or one that is unavailable (2026-10-20). Else the app's.
 */
export async function resolveTitleModel(
  settings: UserSettings,
  turnModel?: LargeLanguageModel,
): Promise<LargeLanguageModel> {
  const cfg = settings.aiConfiguration?.contextSummarization;
  if (cfg?.summarizationModel === "custom" && cfg.customSummarizationModel) {
    return cfg.customSummarizationModel;
  }
  const selected = turnModel ?? settings.selectedModel;
  if (selected.provider === "compass") {
    const { isCoreAutoTier, getCoreModelIdForCoreTier, CORE_TIER_AUTO } =
      await import("@/ipc/shared/compass_constants");
    if (isCoreAutoTier(selected.name)) return selected;
    // Auto, which routes a title (X-Atlarix-Purpose: title) to the cheapest
    // model of the turn's family (owner, 2026-10-30). core-1 used to be the
    // cheap slot; since the renumbering it is GPT-6.1 Terra.
    return getCoreModelIdForCoreTier(CORE_TIER_AUTO)?.trim() ? { provider: "compass", name: CORE_TIER_AUTO } : selected;
  }
  if (LOCAL_PROVIDERS.has(selected.provider)) return selected;
  return (await pickSmallSibling(selected.provider)) ?? selected;
}

/**
 * A title for a session from its first user message, or null when no model
 * produced a usable one — the caller keeps the placeholder. Never throws.
 */
export async function generateSessionTitle(
  firstUserText: string,
  opts: { chatId?: number | null } = {},
): Promise<string | null> {
  const text = firstUserText.trim();
  if (!text) return null;
  try {
    const { generateText } = await import("ai");
    const { readSettings } = await import("@/main/settings");
    const { getModelClient } = await import("@/ipc/utils/get_model_client");
    const { catalogSaysReasons, supportsTemperatureParam } = await import(
      "@/lib/routing/model-reasoning-profile"
    );
    const { recordAuxUsage } = await import(
      "@/lib/usage/turn-usage-aggregator"
    );

    const { turnModelForChat } = await import("@/lib/summarization_model");
    const settings = readSettings();
    const model = await resolveTitleModel(settings, await turnModelForChat(opts.chatId, settings));
    // No key for the provider: getModelClient throws, and there is no title.
    const { modelClient } = await getModelClient(model, settings, {
      purpose: "title",
      ...(opts.chatId != null ? { sessionChatId: opts.chatId } : {}),
    });

    const reasons = catalogSaysReasons(model.provider, model.name) === true;
    const call = (withReasoningOff: boolean) =>
      generateText({
        model: modelClient.model,
        system: TITLE_SYSTEM_PROMPT,
        prompt: titleUserPrompt(text),
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
        ...(supportsTemperatureParam(model.provider, model.name)
          ? { temperature: 0.5 }
          : {}),
        ...(withReasoningOff ? { reasoning: "none" as const } : {}),
        abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        // Atlarix Core takes no SDK retries: the SDK repeats any 429/503, and
        // Core's are gates (busy, limits), answers that a repeat only queues
        // behind (three title requests per busy turn, live QA 2026-10-30).
        ...(modelClient.builtinProviderId === "compass" ? { maxRetries: 0 } : {}),
      });

    let result: Awaited<ReturnType<typeof call>>;
    try {
      result = await call(reasons);
    } catch (firstErr) {
      // The retry only drops `reasoning: "none"`; without it, it is the same
      // request again (two identical POSTs to a provider answering 400).
      if (!reasons) throw firstErr;
      logger.warn("title: first attempt failed, retrying once", firstErr);
      result = await call(false);
    }
    recordAuxUsage(opts.chatId, result.usage, "title");

    const title = sanitizeGeneratedTitle(result.text);
    if (looksLikeReplyNotTitle(title, model.name, text)) {
      logger.info(`title: rejected a reply, not a title: "${title.slice(0, 60)}"`);
      return null;
    }
    return title;
  } catch (err) {
    logger.warn("title: generation failed", err);
    return null;
  }
}
