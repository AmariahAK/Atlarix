import { db } from "../../db";
import { chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import {
  constructSystemPrompt,
  readAiRules,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import { getAtlarixAppPath } from "../../paths/paths";
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

const logger = log.scope("token_count_handlers");

const handle = createLoggedHandler(logger);

export function registerTokenCountHandlers() {
  handle(
    "chat:count-tokens",
    async (event, req: TokenCountParams): Promise<TokenCountResult> => {
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

      // Prepare message history for token counting
      const messageHistory = chat.messages
        .map((message) => message.content)
        .join("");
      const messageHistoryTokens = estimateTokens(messageHistory);

      // Count input tokens
      const inputTokens = estimateTokens(req.input);

      const settings = readSettings();

      // Parse app mentions from the input
      const mentionedAppNames = parseAppMentions(req.input);

      // Count system prompt tokens
      const contextSize = Math.min(await getContextWindow(), 128_000);
      let systemPrompt = constructSystemPrompt({
        aiRules: await readAiRules(chat.app ? getAtlarixAppPath(chat.app.path) : ""),
        chatMode: settings.selectedChatMode === "agent" ? "build" : settings.selectedChatMode,
        contextSize,
        enableTurboEditsV2: isTurboEditsV2Enabled(settings),
      });
      let supabaseContext = "";

      if (chat.app?.supabaseProjectId) {
        systemPrompt += "\n\n" + SUPABASE_AVAILABLE_SYSTEM_PROMPT;
        // TODO: Supabase integration deleted - returns empty for now
        supabaseContext = ""; // was: await getSupabaseContext({ supabaseProjectId: chat.app.supabaseProjectId });
      } else if (
        // Neon projects don't need Supabase.
        !chat.app?.neonProjectId
      ) {
        systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
      }

      const systemPromptTokens = estimateTokens(systemPrompt + supabaseContext);

      // DIAGRAM-FIRST CONTEXT SYSTEM:
      // We no longer use extractCodebase() which dumped 168K+ tokens
      // Instead, we estimate the diagram-first context size
      let codebaseTokens = 0;

      if (chat.app) {
        // Diagram context: ~2-3K tokens
        // Tool instructions: ~500 tokens  
        // Daily logs: ~200 tokens
        // Total: ~3-4K tokens
        const DIAGRAM_CONTEXT_TOKENS = 3500;
        codebaseTokens = DIAGRAM_CONTEXT_TOKENS;
        logger.log(
          `Using diagram-first context estimation: ~${DIAGRAM_CONTEXT_TOKENS} tokens`,
        );
      }

      // Extract codebases for mentioned apps
      const mentionedAppsCodebases = await extractMentionedAppsCodebases(
        mentionedAppNames,
        chat.app?.id, // Exclude current app
      );

      // Calculate tokens for mentioned apps
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

      // Calculate total tokens
      const totalTokens =
        messageHistoryTokens +
        inputTokens +
        systemPromptTokens +
        codebaseTokens +
        mentionedAppsTokens;

      // Find the last assistant message since totalTokens is only set on assistant messages
      const lastAssistantMessage = [...chat.messages]
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
    },
  );
}
