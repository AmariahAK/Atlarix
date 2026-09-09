/**
 * Attach the `task` sub-agent tool to a stream ToolSet (v13).
 *
 * The registry-level `task` tool (spawn-task.ts) is plain; this wrapper adds
 * the live UI plumbing: subagent_start/progress/thought/complete chat:activity
 * events, the per-turn cap, the 5-slot concurrency limiter (multiple task
 * calls in one assistant round run in parallel), and dedupe.
 */

import type { ToolSet } from "ai";
import { BrowserWindow } from "electron";
import type { WebContents } from "electron";
import { ToolRegistry } from "@/lib/tools/registry";
import { normalizeToolInputSchemaForAiSdk } from "@/lib/ai/normalize-tool-schema";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";
import { extractDelegationDisplaySummary } from "@/lib/chat/subagent-summary";
import {
  buildSubagentCompletePayload,
  buildSubagentStartPayload,
  initialSubagentProgressPreview,
} from "@/lib/chat/subagent-activity";
import { MAX_SUBAGENTS_PER_TURN } from "@/lib/agents/agent-runtime";
import {
  acquireDelegationSlot,
  failQueuedDelegationsForChat,
  releaseDelegationSlot,
} from "@/lib/agents/delegation-limiter";
import { creditHaltReason } from "@/lib/agents/credit-halt";
import { cancelAllSubagentTasksForChat } from "@/lib/tools/spawn-task";
import type { WorkMode } from "@/lib/schemas";
import type { SubagentActivityEmit } from "@/lib/agents/run-subagent";

export type DelegationStreamContext = {
  sender: WebContents;
  chatId: number;
  effectiveWorkMode: WorkMode;
  workspacePath?: string;
  workspaceId?: number;
  turnId: string;
  safeSend: (sender: WebContents, channel: string, payload: unknown) => void;
  onDelegated?: (agentId: string) => void;
  /** Count of sub-agents started this turn (in-flight + completed). */
  getDelegationCount?: () => number;
  onDelegationStart?: () => void;
  tryAcquireDedupeKey?: (key: string) => boolean;
  releaseDedupeKey?: (key: string) => void;
};

/**
 * Stop the rest of this round once the wallet is empty.
 *
 * Two distinct populations, and cancelling only the first is what left a fan-out
 * running: the sub-agents already streaming (aborted through the task store) and the
 * ones parked behind the concurrency limiter, which no cancellation path touched.
 */
function haltRoundForCredit(ctx: DelegationStreamContext): void {
  const reason = creditHaltReason(ctx.chatId);
  if (!reason) return;
  failQueuedDelegationsForChat(ctx.chatId, new Error(reason));
  cancelAllSubagentTasksForChat(ctx.chatId, reason);
}

function newDelegationId(agentId: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : String(Math.random()).slice(2, 10);
  return `delegation-${Date.now()}-${agentId}-${suffix}`;
}

function delegationChatModeFromWorkMode(
  workMode: WorkMode,
): "build" | "plan" | "ask" {
  if (workMode === "plan") return "plan";
  if (workMode === "build" || workMode === "debug") return "build";
  return "ask";
}

/**
 * v14.8.11: the sub-agent popup's bottom section renders this DISPLAY summary — it
 * must be the sub-agent's final answer, not the stringified registry envelope.
 *
 * The implementation moved to `@/lib/chat/subagent-summary` so the RENDERER can use
 * it too (this module imports the tool registry and Electron). Re-exported here
 * because the main-process call sites and their tests import it from this path.
 */
export { extractDelegationDisplaySummary };

export function attachDelegationToolsToSet(
  tools: ToolSet,
  ctx: DelegationStreamContext,
): void {
  const delegationChatMode = delegationChatModeFromWorkMode(
    ctx.effectiveWorkMode,
  );

  const taskTool = ToolRegistry.get("task");
  if (!taskTool) return;

  tools.task = {
    description: taskTool.description,
    inputSchema: normalizeToolInputSchemaForAiSdk(
      taskTool.parameters ?? {},
    ) as never,
    execute: async (args: Record<string, unknown>) => {
      /**
       * The credit latch is checked FIRST, ahead of the per-turn cap.
       *
       * Once the wallet is empty, "the round stopped because you are out of credit"
       * is the only useful thing to say. Falling through to the cap's refusal would
       * tell the model to "fold the work into fewer prompts" — advice that cannot
       * help, and that invites it to keep spawning. Cancelling a round without this
       * latch does not stop it either: nothing here touches the per-turn count or
       * the dedupe set, so the model could simply call `task` again.
       */
      const haltReason = creditHaltReason(ctx.chatId);
      if (haltReason) {
        return JSON.stringify({ success: false, error: haltReason });
      }

      const activeCount = ctx.getDelegationCount?.() ?? 0;
      if (activeCount >= MAX_SUBAGENTS_PER_TURN) {
        return JSON.stringify({
          success: false,
          error: `Maximum ${MAX_SUBAGENTS_PER_TURN} sub-agents per turn. Wait for running tasks or fold the work into fewer prompts.`,
        });
      }

      const agentId = String(args.subagent_type ?? "").trim() || "scout";
      const task = String(args.prompt ?? args.description ?? "");
      const dedupeKey = `${agentId}|${task.slice(0, 200)}`;
      if (ctx.tryAcquireDedupeKey && !ctx.tryAcquireDedupeKey(dedupeKey)) {
        return JSON.stringify({
          success: false,
          error:
            "A sub-agent with the same prompt is already running. Vary the scope or wait for it to finish.",
        });
      }

      ctx.onDelegationStart?.();

      ctx.safeSend(ctx.sender, "chat:tool:start", {
        chatId: ctx.chatId,
        toolId: "task",
        toolName: getToolActivityLabel("task"),
      });
      // The concurrency cap IS the per-turn cap. `ctx.maxConcurrentDelegations`
      // used to be read here and no caller ever set it — neither build-branch nor
      // ask-branch passed it — so the schema field behind it did nothing. Both are
      // gone; this names the real constant instead of implying a knob.
      const maxConcurrent = MAX_SUBAGENTS_PER_TURN;
      const id = newDelegationId(agentId);
      const startTime = Date.now();
      const startPayload = buildSubagentStartPayload({
        id,
        chatId: ctx.chatId,
        agentId,
        task,
        scope: undefined,
        parentToolId: "task",
        roundId: ctx.turnId,
        timestamp: startTime,
      });

      try {
        await acquireDelegationSlot(
          ctx.chatId,
          ctx.turnId,
          maxConcurrent,
          () => {
            ctx.safeSend(ctx.sender, "chat:activity", {
              type: "subagent_progress",
              id,
              chatId: ctx.chatId,
              agent: agentId,
              agentType: agentId,
              parentDelegationId: id,
              roundId: ctx.turnId,
              status: "running",
              timestamp: Date.now(),
              preview: "Queued — waiting for a sub-agent slot…",
              label: "Queued",
            });
          },
        );
      } catch (err) {
        // The queue was failed while this delegation was parked — the round halted
        // behind our back. Hand back what we took by hand: the `finally` below
        // belongs to the block we never entered, so nothing else releases the dedupe
        // key or closes the tool card. No `releaseDelegationSlot` — a rejected queue
        // entry never held a slot, and the slot record is already gone.
        ctx.releaseDedupeKey?.(dedupeKey);
        ctx.safeSend(ctx.sender, "chat:tool:end", { chatId: ctx.chatId });
        return JSON.stringify({
          success: false,
          error:
            creditHaltReason(ctx.chatId) ??
            (err instanceof Error ? err.message : String(err)),
        });
      }

      try {
        ctx.safeSend(ctx.sender, "chat:activity", startPayload);
        const startPreview = initialSubagentProgressPreview(undefined, task);
        ctx.safeSend(ctx.sender, "chat:activity", {
          type: "subagent_progress",
          id,
          chatId: ctx.chatId,
          agent: agentId,
          agentType: agentId,
          parentDelegationId: id,
          roundId: ctx.turnId,
          status: "running",
          timestamp: Date.now(),
          preview: startPreview,
          label: startPreview,
        });

        const emitSubagentActivity = (payload: SubagentActivityEmit) => {
          const ts = Date.now();
          if (payload.type === "subagent_progress") {
            ctx.safeSend(ctx.sender, "chat:activity", {
              type: "subagent_progress",
              id,
              chatId: ctx.chatId,
              agent: agentId,
              agentType: agentId,
              parentDelegationId: id,
              roundId: ctx.turnId,
              status: "running",
              timestamp: ts,
              preview: payload.preview,
              label: payload.preview,
            });
            return;
          }
          if (payload.type === "subagent_thought") {
            // Rolling live model output — stable id per segment; the renderer
            // upserts so the block grows in place instead of appending lines.
            ctx.safeSend(ctx.sender, "chat:activity", {
              type: "subagent_thought",
              id: payload.id,
              chatId: ctx.chatId,
              agent: agentId,
              agentType: agentId,
              parentDelegationId: id,
              roundId: ctx.turnId,
              status: "running",
              timestamp: ts,
              preview: payload.content,
              channel: payload.channel,
            });
            return;
          }
          if (payload.type === "subagent_tokens") {
            // Live cumulative token usage → the card's "tok" badge.
            ctx.safeSend(ctx.sender, "chat:activity", {
              type: "subagent_tokens",
              id,
              chatId: ctx.chatId,
              agent: agentId,
              agentType: agentId,
              parentDelegationId: id,
              roundId: ctx.turnId,
              status: "running",
              timestamp: ts,
              tokens: payload.tokens,
            });
            return;
          }
          ctx.safeSend(ctx.sender, "chat:activity", {
            type: "tool_use",
            id: payload.id,
            chatId: ctx.chatId,
            toolName: payload.toolName,
            label:
              payload.label?.trim() || getToolActivityLabel(payload.toolName),
            status: payload.status === "running" ? "running" : payload.status,
            timestamp: ts,
            detail: payload.detail,
            // Forward args + result so the nested card renders an inline diff
            // (normalizeChatActivityPayload → streamThreadItemFromActivity →
            // buildToolExpandView). Without these the card falls back to a bare
            // "Editing file: N lines" label with no diff.
            toolArgs: payload.toolArgs,
            resultText: payload.resultText,
            parentDelegationId: id,
            roundId: ctx.turnId,
          });
        };

        const result = await ToolRegistry.execute("task", {
          ...args,
          workspace: ctx.workspacePath || undefined,
          workspaceId: ctx.workspaceId,
          delegationChatMode,
          chatId: ctx.chatId,
          turnId: ctx.turnId,
          parentDelegationId: id,
          // Which window spawned this worker, so a sub-agent's browser calls
          // target THAT window's tabs.
          //
          // `_ownerWindowId` is normally injected at the single tool-execution
          // funnel (chat_stream/tool-execute.ts), which this delegation wrapper
          // bypasses. Without it `resolveBrowserScope` silently falls back to the
          // FOCUSED window and then the first window — so a worker would drive
          // whichever window the user happened to be looking at, and retarget
          // mid-task if they switched. That is worse than an error, because
          // nothing reports it.
          ownerWindowId: BrowserWindow.fromWebContents(ctx.sender)?.id,
          emitSubagentActivity,
          // Settles the card for a BACKGROUNDED run, which returns long before
          // its sub-agent finishes. This closure outlives the tool call — the
          // same way background narration already reaches the UI — so the card
          // resolves the moment the run really ends, not on the next turn.
          onBackgroundSettled: (settled: {
            summary: string;
            isError: boolean;
            durationMs: number;
          }) => {
            ctx.safeSend(
              ctx.sender,
              "chat:activity",
              buildSubagentCompletePayload({
                id,
                chatId: ctx.chatId,
                agentId,
                summary: settled.summary.slice(0, 4_000),
                duration: settled.durationMs,
                isError: settled.isError,
                scope: undefined,
                roundId: ctx.turnId,
              }),
            );
          },
        });
        ctx.onDelegated?.(agentId);

        const duration = Date.now() - startTime;
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result);

        // v14.8.11: the DISPLAY summary must be the sub-agent's final answer,
        // not the stringified registry envelope — the popup used to render
        // {"success":true,"result":"<task …"} verbatim at its bottom. Unwrap
        // the envelope + <task>/<summary>/<task_result> markup; the model-
        // facing return (resultStr, below) is untouched.
        const {
          summary: innerResult,
          isError,
          isRunning,
        } = extractDelegationDisplaySummary(result, resultStr);

        // A backgrounded or auto-promoted task RETURNS while its sub-agent is
        // still working. Settling the card here marked it "completed" the
        // instant it started — the header said "1 completed" while the main
        // agent's own narration said the sub-agent was still going. The real
        // completion is emitted by the settle callback wired above, when the
        // run actually finishes.
        if (!isRunning) {
          ctx.safeSend(
            ctx.sender,
            "chat:activity",
            buildSubagentCompletePayload({
              id,
              chatId: ctx.chatId,
              agentId,
              summary: innerResult.slice(0, 4_000),
              duration,
              isError,
              scope: undefined,
              roundId: ctx.turnId,
            }),
          );
        }

        return resultStr;
      } finally {
        // ORDER IS LOAD-BEARING. `releaseDelegationSlot` drains the queue, so a
        // parked sibling would be granted a slot and open its own 402-bound call
        // before anything got the chance to stop it. Halt first, then release.
        haltRoundForCredit(ctx);
        ctx.releaseDedupeKey?.(dedupeKey);
        releaseDelegationSlot(ctx.chatId, ctx.turnId, maxConcurrent);
        ctx.safeSend(ctx.sender, "chat:tool:end", { chatId: ctx.chatId });
      }
    },
  };
}
