import { ToolRegistry, ToolCategory } from "./registry";
import { estimateTokens } from "@/ipc/utils/token_utils";
import { runSteppedCompaction } from "../context/compaction";
import { runCompaction, type CompactionRunOutcome } from "../context-compaction";
import { getUsableBudget } from "../context-compaction";

/**
 * PASS2: Compaction is model-triggered via this tool.
 *
 * NOTE:
 * Tool handlers do not have access to the stream handler's sender/chat scope in this codebase.
 * The actual compaction execution + activity emission is performed at the tool execution callsites
 * inside streaming handlers (workspace + chat-only). This tool exists to expose the contract to the model.
 */
export type ExecuteCompressContextContext = {
  chatId: number;
  messages: Array<{ id: number; role: string; content: string }>;
  systemPromptTokens: number;
  inputTokens?: number;
  providerId?: string;
  sessionStats?: { toolCallCount?: number; delegationCount?: number };
  turnId?: string | null;
  /**
   * When true, use in-memory compaction (no DB writes) and optionally update the caller's
   * transcript via setMessages.
   */
  ephemeral?: boolean;
  setMessages?: (next: Array<{ id: number; role: string; content: string }>) => void;
};

export async function executeCompressContext(
  params: { reason?: string },
  ctx: ExecuteCompressContextContext,
): Promise<{
  success: boolean;
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  status: CompactionRunOutcome["status"];
}> {
  const reason =
    typeof params.reason === "string" && params.reason.trim()
      ? params.reason.trim()
      : "model-initiated";

  const msgList = (ctx.messages ?? []).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content ?? "",
  }));
  const tokensBefore = msgList.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);

  // Ephemeral/chat-only: in-memory stepped compaction + optional transcript replacement
  if (ctx.ephemeral === true || ctx.chatId < 0) {
    const tierLimit = getUsableBudget(ctx.providerId);
    const stepped = await runSteppedCompaction(msgList, tierLimit, ctx.providerId);
    const afterList = stepped.modelContext ?? msgList;
    const tokensAfter = afterList.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);
    if (ctx.setMessages) {
      ctx.setMessages(afterList.map((m) => ({ id: m.id, role: m.role, content: m.content || "" })));
    }
    return {
      success: stepped.compactionApplied === true,
      reason,
      tokensBefore,
      tokensAfter,
      summary: stepped.summaryText ?? "Context compressed.",
      status: stepped.compactionApplied === true ? "completed" : "noop",
    };
  }

  // Workspace/DB chats: reuse the existing compaction persistence pipeline
  const compactionResult = await runCompaction({
    chatId: ctx.chatId,
    chatMessages: msgList,
    systemPromptTokens: ctx.systemPromptTokens,
    inputTokens: ctx.inputTokens ?? 0,
    providerId: ctx.providerId,
    sessionStats: ctx.sessionStats,
    turnId: ctx.turnId ?? null,
  });
  const afterList = compactionResult.status === "completed" ? compactionResult.messagesAfterSummary : msgList;
  const tokensAfter = afterList.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);

  return {
    success: compactionResult.status === "completed",
    reason,
    tokensBefore,
    tokensAfter,
    summary:
      compactionResult.status === "completed"
        ? compactionResult.summaryText
        : `No compaction performed: ${compactionResult.reason}`,
    status: compactionResult.status,
  };
}

ToolRegistry.register({
  name: "compress_context",
  requiresWorkspace: false,
  isReadOnly: true,
  allowInAskMode: true,
  category: ToolCategory.ANALYSIS,
  cost: 0,
  description:
    "Compress older completed parts of this conversation to free up context for the current task. " +
    "Call this when: (1) you finished a major subtask and want a clean context, (2) you notice context pressure building, " +
    "or (3) a long back-and-forth has accumulated and earlier parts are no longer needed verbatim. " +
    "This tool is available in Ask, Plan, Build, Debug, Review, and chat-only modes. " +
    "Do not call this preemptively on every turn — only when context pressure is real.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Brief explanation of why compression is needed now (for the activity log).",
      },
    },
    required: [],
  },
  handler: async ({ reason }: { reason?: string }) => {
    return {
      __compress_context_requested: true,
      reason: typeof reason === "string" && reason.trim() ? reason.trim() : "model-initiated",
    };
  },
});

