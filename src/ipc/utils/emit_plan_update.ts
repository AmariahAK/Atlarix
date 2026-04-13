import type { WebContents } from "electron";
import type { TaskLedger } from "@/lib/tasks/task-ledger";
import type { PlanUpdatePayload } from "@/ipc/ipc_types";
import { safeSend } from "./safe_sender";

function planCardStatusFromLedger(ledger: TaskLedger): PlanUpdatePayload["status"] {
  if (ledger.finishReason === "complete") return "complete";
  if (ledger.finishReason === "failed") return "failed";
  if (ledger.finishReason === "cancelled") return "failed";
  if (ledger.steps.some((s) => s.status === "failed")) return "failed";
  if (ledger.steps.some((s) => s.status === "in_progress")) return "in_progress";
  return "pending";
}

export function buildPlanUpdatePayload(
  ledger: TaskLedger,
  assistantMessageId: number,
): PlanUpdatePayload {
  return {
    chatId: ledger.chatId,
    turnId: ledger.turnId,
    assistantMessageId,
    task: ledger.originalTask,
    steps: ledger.steps.map((s) => ({
      id: s.id,
      description: s.description,
      status: s.status,
      completedAt: s.completedAt,
    })),
    status: planCardStatusFromLedger(ledger),
  };
}

export function emitPlanUpdate(
  sender: WebContents,
  ledger: TaskLedger,
  assistantMessageId: number,
): void {
  if (!ledger.steps.length) return;
  safeSend(sender, "chat:plan-update", buildPlanUpdatePayload(ledger, assistantMessageId));
}
