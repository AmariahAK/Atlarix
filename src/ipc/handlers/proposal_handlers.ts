import { type IpcMainInvokeEvent } from "electron";
import type {
  CodeProposal,
  ProposalResult,
  ActionProposal,
} from "../../lib/schemas";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getStreamTransport, getStreamTransportAppId } from "@/lib/chat/stream-transport";
import type { Message } from "../ipc_types";
import path from "node:path"; // Import path for basename
import { isServerFunction } from "../../supabase_admin/supabase_utils";
// Import tag parsers
import { processFullResponseActions } from "../processors/response_processor";
import {
  getAtlarixWriteTags,
  getAtlarixRenameTags,
  getAtlarixDeleteTags,
  getAtlarixExecuteSqlTags,
  getAtlarixChatSummaryTag,
  getAtlarixCommandTags,
  getAtlarixSearchReplaceTags,
} from "../utils/atlarix_tag_parser";
import log from "electron-log";
import {
  estimateMessagesTokens,
  getContextWindow,
} from "../utils/token_utils";
import { withLock } from "../utils/lock_utils";
import { createLoggedHandler } from "./safe_handle";
import { ApproveProposalResult } from "../ipc_types";
import { readSettings } from "@/main/settings";

const logger = log.scope("proposal_handlers");
const handle = createLoggedHandler(logger);
// Cache for codebase token counts
interface CodebaseTokenCache {
  chatId: number;
  messageId: number;
  messageContent: string;
  tokenCount: number;
  timestamp: number;
  chatContext: string;
}

// Cache expiration time (5 minutes)
const CACHE_EXPIRATION_MS = 5 * 60 * 1000;

// In-memory cache for codebase token counts
const codebaseTokenCache = new Map<number, CodebaseTokenCache>();

// Function to clean up expired cache entries
function cleanupExpiredCacheEntries() {
  const now = Date.now();
  let expiredCount = 0;

  codebaseTokenCache.forEach((entry, key) => {
    if (now - entry.timestamp > CACHE_EXPIRATION_MS) {
      codebaseTokenCache.delete(key);
      expiredCount++;
    }
  });

  if (expiredCount > 0) {
    logger.log(
      `Cleaned up ${expiredCount} expired codebase token cache entries`,
    );
  }
}

// Function to get cached token count or calculate and cache it
// DIAGRAM-FIRST: Now returns estimated diagram context tokens (~3-4K) instead of full codebase (168K)
async function getCodebaseTokenCount(
  chatId: number,
  _messageId: number,
  _messageContent: string,
  _appPath: string,
  _chatContext: unknown,
): Promise<number> {
  // Clean up expired cache entries first
  cleanupExpiredCacheEntries();

  const cacheEntry = codebaseTokenCache.get(chatId);
  const now = Date.now();

  // Check if cache is valid
  if (cacheEntry && now - cacheEntry.timestamp < CACHE_EXPIRATION_MS) {
    logger.log(`Using cached context token count for chatId: ${chatId}`);
    return cacheEntry.tokenCount;
  }

  // DIAGRAM-FIRST CONTEXT SYSTEM:
  // We no longer dump the full codebase (168K tokens)
  // Instead, we use:
  // - Diagram context: ~2-3K tokens
  // - Tool instructions: ~500 tokens
  // - Daily logs: ~200 tokens
  // Total: ~3-4K tokens

  // PASS8 I: Diagram generation is model-driven only — no auto-injection on
  // workspace open. Match `token_count_handlers.ts` which already reports 0,
  // so the budget the UI sees and what the stream actually sends are in sync.
  const DIAGRAM_CONTEXT_TOKENS = 0;

  logger.log(`Using diagram-first context estimation for chatId: ${chatId}: ~${DIAGRAM_CONTEXT_TOKENS} tokens (model-driven only)`);

  // Store in cache
  codebaseTokenCache.set(chatId, {
    chatId,
    messageId: 0,
    messageContent: "",
    tokenCount: DIAGRAM_CONTEXT_TOKENS,
    timestamp: now,
    chatContext: "",
  });

  return DIAGRAM_CONTEXT_TOKENS;
}

function latestEphemeralAssistant(
  chatId: number,
): Pick<Message, "id" | "content" | "approvalState"> | undefined {
  const chat = getStreamTransport(chatId);
  if (!chat?.messages?.length) return undefined;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === "assistant") {
      return {
        id: m.id,
        content: m.content,
        approvalState: m.approvalState,
      };
    }
  }
  return undefined;
}

const getProposalHandler = async (
  _event: IpcMainInvokeEvent,
  { chatId }: { chatId: number },
): Promise<ProposalResult | null> => {
  return withLock("get-proposal:" + chatId, async () => {
    logger.log(`IPC: get-proposal called for chatId: ${chatId}`);

    try {
      const latestAssistantMessage = latestEphemeralAssistant(chatId);

      if (
        latestAssistantMessage?.content &&
        latestAssistantMessage.id &&
        !latestAssistantMessage?.approvalState
      ) {
        const messageId = latestAssistantMessage.id; // Get the message ID
        logger.log(
          `Found latest assistant message (ID: ${messageId}), parsing content...`,
        );
        const messageContent = latestAssistantMessage.content;

        const proposalTitle = getAtlarixChatSummaryTag(messageContent);

        const proposalWriteFiles = getAtlarixWriteTags(messageContent);
        const proposalSearchReplaceFiles =
          getAtlarixSearchReplaceTags(messageContent);
        const proposalRenameFiles = getAtlarixRenameTags(messageContent);
        const proposalDeleteFiles = getAtlarixDeleteTags(messageContent);
        const proposalExecuteSqlQueries = getAtlarixExecuteSqlTags(messageContent);

        const filesChanged = [
          ...proposalWriteFiles
            .concat(proposalSearchReplaceFiles)
            .map((tag) => ({
              name: path.basename(tag.path),
              path: tag.path,
              summary: tag.description ?? "(no change summary found)", // Generic summary
              type: "write" as const,
              isServerFunction: isServerFunction(tag.path),
            })),
          ...proposalRenameFiles.map((tag) => ({
            name: path.basename(tag.to),
            path: tag.to,
            summary: `Rename from ${tag.from} to ${tag.to}`,
            type: "rename" as const,
            isServerFunction: isServerFunction(tag.to),
          })),
          ...proposalDeleteFiles.map((tag) => ({
            name: path.basename(tag),
            path: tag,
            summary: `Delete file`,
            type: "delete" as const,
            isServerFunction: isServerFunction(tag),
          })),
        ];
        // Check if we have enough information to create a proposal
        if (
          filesChanged.length > 0 ||
          proposalExecuteSqlQueries.length > 0
        ) {
          const proposal: CodeProposal = {
            type: "code-proposal",
            // Use parsed title or a default title if summary tag is missing but write tags exist
            title: proposalTitle ?? "Proposed File Changes",
            securityRisks: [], // Keep empty
            filesChanged,
            packagesAdded: [], // Dependencies now go through run_command
            sqlQueries: proposalExecuteSqlQueries.map((query) => ({
              content: query.content,
              description: query.description,
            })),
          };
          logger.log(
            "Generated code proposal. title=",
            proposal.title,
            "files=",
            proposal.filesChanged.length,
          );

          return {
            proposal: proposal,
            chatId,
            messageId,
          };
        } else {
          logger.log(
            "No relevant tags found in the latest assistant message content.",
          );
        }
      }
      const actions: ActionProposal["actions"] = [];
      if (latestAssistantMessage?.content) {
        const writeTags = getAtlarixWriteTags(latestAssistantMessage.content);
        const refactorTarget = writeTags.reduce(
          (largest, tag) => {
            const lineCount = tag.content.split("\n").length;
            return lineCount > 500 &&
              (!largest || lineCount > largest.lineCount)
              ? { path: tag.path, lineCount }
              : largest;
          },
          null as { path: string; lineCount: number } | null,
        );
        if (refactorTarget) {
          actions.push({
            id: "refactor-file",
            path: refactorTarget.path,
          });
        }
        if (
          writeTags.length === 0 &&
          latestAssistantMessage.content.includes("```")
        ) {
          actions.push({
            id: "write-code-properly",
          });
        }

        // Check for command tags and add corresponding actions
        const commandTags = getAtlarixCommandTags(latestAssistantMessage.content);
        if (commandTags.includes("rebuild")) {
          actions.push({
            id: "rebuild",
          });
        }
        if (commandTags.includes("restart")) {
          actions.push({
            id: "restart",
          });
        }
        if (commandTags.includes("refresh")) {
          actions.push({
            id: "refresh",
          });
        }
      }

      const ephemeral = getStreamTransport(chatId);
      const appId = getStreamTransportAppId(chatId);
      const app = appId
        ? await db.query.apps.findFirst({ where: eq(apps.id, appId) })
        : null;

      if (latestAssistantMessage && ephemeral && app) {
        const messagesTokenCount = estimateMessagesTokens(ephemeral.messages);

        let codebaseTokenCount = 0;
        if (app.path) {
          codebaseTokenCount = await getCodebaseTokenCount(
            chatId,
            latestAssistantMessage.id,
            latestAssistantMessage.content || "",
            app.path,
            app.chatContext,
          );
        }

        const totalTokens = messagesTokenCount + codebaseTokenCount;
        // Use the model's REAL context window (pass chatId so Compass chats use
        // the per-chat TTFT-captured window). No artificial cap — this was the
        // only caller that clamped, which made the % wrong and fired the
        // summarize nudge far too early for >100K models.
        const contextWindow = await getContextWindow(undefined, chatId);
        logger.log(
          `Token usage: ${totalTokens}/${contextWindow} (${(totalTokens / contextWindow) * 100
          }%)`,
        );

        if (totalTokens > contextWindow * 0.8 || ephemeral.messages.length > 10) {
          logger.log(
            `Token usage is high (${totalTokens}/${contextWindow}) OR long chat history (${ephemeral.messages.length} messages), suggesting summarize action`,
          );
          actions.push({
            id: "summarize-in-new-chat",
          });
        }
      }
      if (latestAssistantMessage) {
        actions.push({
          id: "keep-going",
        });
        return {
          proposal: {
            type: "action-proposal",
            actions: actions,
          },
          chatId,
          messageId: latestAssistantMessage.id,
        };
      }
      return null;
    } catch (error) {
      logger.error(`Error processing proposal for chatId ${chatId}:`, error);
      return null; // Indicate DB or processing error
    }
  });
};

// Handler to approve a proposal (process actions and update message)
const approveProposalHandler = async (
  _event: IpcMainInvokeEvent,
  { chatId, messageId }: { chatId: number; messageId: number },
): Promise<ApproveProposalResult> => {
  const settings = readSettings();
  if (settings.selectedChatMode === "ask") {
    throw new Error(
      "Ask mode is not supported for proposal approval. Please switch to build mode.",
    );
  }
  const ephemeral = getStreamTransport(chatId);
  const messageToApprove = ephemeral?.messages.find(
    (m) => m.id === messageId && m.role === "assistant",
  );

  if (!messageToApprove?.content) {
    throw new Error(
      `Assistant message not found for chatId: ${chatId}, messageId: ${messageId}`,
    );
  }

  // 2. Process the actions defined in the message content
  const chatSummary = getAtlarixChatSummaryTag(messageToApprove.content);
  const processResult = await processFullResponseActions(
    messageToApprove.content,
    chatId,
    {
      chatSummary: chatSummary ?? undefined,
      messageId,
    }, // Pass summary if found
  );

  if (processResult.error) {
    throw new Error(
      `Error processing actions for message ${messageId}: ${processResult.error}`,
    );
  }

  return {
    extraFiles: processResult.extraFiles,
    extraFilesError: processResult.extraFilesError,
  };
};

// Handler to reject a proposal (just update message state)
const rejectProposalHandler = async (
  _event: IpcMainInvokeEvent,
  { chatId, messageId }: { chatId: number; messageId: number },
): Promise<void> => {
  logger.log(
    `IPC: reject-proposal called for chatId: ${chatId}, messageId: ${messageId}`,
  );

  const ephemeral = getStreamTransport(chatId);
  const messageToReject = ephemeral?.messages.find(
    (m) => m.id === messageId && m.role === "assistant",
  );

  if (!messageToReject) {
    throw new Error(
      `Assistant message not found for chatId: ${chatId}, messageId: ${messageId}`,
    );
  }

  messageToReject.approvalState = "rejected";
  logger.log(`Message ${messageId} marked as rejected (in-memory).`);
};

// Function to register proposal-related handlers
export function registerProposalHandlers() {
  handle("get-proposal", getProposalHandler);
  handle("approve-proposal", approveProposalHandler);
  handle("reject-proposal", rejectProposalHandler);
}
