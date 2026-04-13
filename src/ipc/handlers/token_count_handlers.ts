import { db } from "../../db";
import { apps, chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import {
  constructSystemPrompt,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import log from "electron-log";
// extractCodebase removed - using diagram-first context system

import { TokenCountParams } from "../ipc_types";
import { TokenCountResult } from "../ipc_types";
import { estimateTokens, getContextWindow, getEffectiveBudget } from "../utils/token_utils";
import { createLoggedHandler } from "./safe_handle";
import { readSettings } from "@/main/settings";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import { getEphemeralChat, isEphemeralChatId } from "./chat_only_handlers";

const logger = log.scope("token_count_handlers");

const handle = createLoggedHandler(logger);

type TokenCountMessageRow = {
  content: string;
  role: string;
  maxTokensUsed?: number | null;
  createdAt?: Date;
};

type AppRowForTokens = {
  id: number;
  supabaseProjectId: string | null;
  neonProjectId: string | null;
} | null;

async function computeTokenCountResult(
  req: TokenCountParams,
  messages: TokenCountMessageRow[],
  app: AppRowForTokens,
): Promise<TokenCountResult> {
  const ordered = [...messages].sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? 0;
    const tb = b.createdAt?.getTime() ?? 0;
    return ta - tb;
  });

  const messageHistory = ordered.map((message) => message.content).join("");
  const messageHistoryTokens = estimateTokens(messageHistory);

  const inputTokens = estimateTokens(req.input);

  const settings = readSettings();

  const mentionedAppNames = parseAppMentions(req.input);

  const contextSize = Math.min(await getContextWindow(), 128_000);
  let systemPrompt = constructSystemPrompt({
    chatMode: settings.selectedChatMode === "agent" ? "build" : settings.selectedChatMode,
    contextSize,
    enableTurboEditsV2: isTurboEditsV2Enabled(settings),
  });
  let supabaseContext = "";

  if (app?.supabaseProjectId) {
    systemPrompt += "\n\n" + SUPABASE_AVAILABLE_SYSTEM_PROMPT;
    supabaseContext = "";
  } else if (!app?.neonProjectId) {
    systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
  }

  const systemPromptTokens = estimateTokens(systemPrompt + supabaseContext);

  let codebaseTokens = 0;

  if (app) {
    const DIAGRAM_CONTEXT_TOKENS = 3500;
    codebaseTokens = DIAGRAM_CONTEXT_TOKENS;
    logger.log(
      `Using diagram-first context estimation: ~${DIAGRAM_CONTEXT_TOKENS} tokens`,
    );
  }

  const mentionedAppsCodebases = await extractMentionedAppsCodebases(
    mentionedAppNames,
    app?.id,
  );

  let mentionedAppsTokens = 0;
  if (mentionedAppsCodebases.length > 0) {
    const mentionedAppsContent = mentionedAppsCodebases
      .map(
        ({ appName, codebaseInfo }) =>
          `\n\n=== Referenced App: ${appName} ===\n${codebaseInfo}`,
      )
      .join("");

    mentionedAppsTokens = estimateTokens(mentionedAppsContent);

    logger.log(
      `Extracted ${mentionedAppsCodebases.length} mentioned app codebases, tokens: ${mentionedAppsTokens}`,
    );
  }

  const totalTokens =
    messageHistoryTokens +
    inputTokens +
    systemPromptTokens +
    codebaseTokens +
    mentionedAppsTokens;

  const lastAssistantMessage = [...ordered]
    .reverse()
    .find((m) => m.role === "assistant");
  const actualMaxTokens = lastAssistantMessage?.maxTokensUsed ?? null;

  const providerId = settings.selectedModel?.provider ?? "auto";
  const { budget: effectiveBudget, source: budgetSource } = await getEffectiveBudget(providerId);
  const contextWindow = await getContextWindow();

  return {
    estimatedTotalTokens: totalTokens,
    actualMaxTokens,
    messageHistoryTokens,
    codebaseTokens,
    mentionedAppsTokens,
    inputTokens,
    systemPromptTokens,
    contextWindow,
    effectiveBudget,
    providerId,
    budgetSource,
  };
}

export function registerTokenCountHandlers() {
  handle(
    "chat:count-tokens",
    async (_event, req: TokenCountParams): Promise<TokenCountResult> => {
      if (isEphemeralChatId(req.chatId)) {
        const ephemeral = getEphemeralChat(req.chatId);
        if (!ephemeral) {
          throw new Error(`Chat not found: ${req.chatId}`);
        }
        let app: AppRowForTokens = null;
        if (ephemeral.appId != null) {
          app =
            (await db.query.apps.findFirst({
              where: eq(apps.id, ephemeral.appId),
            })) ?? null;
        }
        const rows: TokenCountMessageRow[] = (ephemeral.messages ?? []).map((m) => ({
          content: typeof m.content === "string" ? m.content : "",
          role: m.role,
          maxTokensUsed:
            "maxTokensUsed" in m && m.maxTokensUsed != null
              ? (m as { maxTokensUsed: number | null }).maxTokensUsed
              : null,
          createdAt:
            "createdAt" in m && m.createdAt instanceof Date
              ? m.createdAt
              : undefined,
        }));
        return computeTokenCountResult(req, rows, app);
      }

      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: {
            orderBy: (messages, { asc }) => [asc(messages.createdAt)],
          },
          app: true,
        },
      });

      if (!chat) {
        throw new Error(`Chat not found: ${req.chatId}`);
      }

      const rows: TokenCountMessageRow[] = chat.messages.map((m) => ({
        content: m.content,
        role: m.role,
        maxTokensUsed: m.maxTokensUsed,
        createdAt: m.createdAt,
      }));

      return computeTokenCountResult(req, rows, chat.app ?? null);
    },
  );
}
