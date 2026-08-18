/**
 * "Something is waiting for you" — anchored above the composer.
 *
 * Approval cards render inline in the transcript, which is right for the record
 * (you can see which turn asked for what) and wrong for ACTING: on a long turn
 * the card scrolls away, and the reported experience was not knowing anything was
 * pending without scrolling all the way back.
 *
 * So the transcript keeps the cards and this keeps the attention. It sits beside
 * `ParkedWaitingChip` directly above the text box, self-hides when nothing is
 * pending, and reads the same `permissionQueueAtom` the inline cards do — acting
 * in either place updates both, because there is one queue, not two.
 *
 * Deliberately NOT a second copy of the per-card UI. Duplicating diffs and
 * per-scope buttons would mean two places to keep correct, and the inline card is
 * where a diff belongs. This answers "what is waiting, and can I clear it from
 * here" — and jumps you to the card when the answer needs a diff.
 */
import { useAtomValue } from "jotai";
import { ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import {
  permissionQueueAtom,
  getOperationsByStatus,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";

/**
 * What ONE waiting operation is asking for.
 *
 * Exported because the inline status pill needs the same sentence: two places
 * describing the same queue in different words is how one of them ends up wrong.
 */
export function describePendingApproval(op: QueuedOperation): string {
  if (op.operation === "run_command" && op.command) {
    return `Approve command: ${op.command.slice(0, 60)}`;
  }
  // A folder grant carries no `path` and is not a command, so it used to fall
  // through to the bare "1 approval waiting" — which does not say what to click or
  // why. Naming the folder is the whole point of the card.
  if (op.operation === "sandbox_escalation") {
    const folder = op.sandboxGrantPath ?? op.sandboxDeniedPath;
    return folder
      ? `Grant write access: ${folder}`
      : "Grant write access to a folder outside the workspace";
  }
  if (op.path) return `Approve edit: ${op.path}`;
  return "1 approval waiting";
}

/** A short, honest description of what is waiting. */
export function describePending(ops: QueuedOperation[]): string {
  if (ops.length === 0) return "";
  if (ops.length === 1) return describePendingApproval(ops[0]);
  const files = ops.filter((o) => o.path).length;
  const commands = ops.filter((o) => o.operation === "run_command").length;
  const grants = ops.filter((o) => o.operation === "sandbox_escalation").length;
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (commands > 0) parts.push(`${commands} command${commands === 1 ? "" : "s"}`);
  // Counted explicitly: a grant is neither a file nor a command, so a mixed batch
  // used to report a total that its own breakdown did not account for.
  if (grants > 0) parts.push(`${grants} folder grant${grants === 1 ? "" : "s"}`);
  const what = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${ops.length} approvals waiting${what}`;
}

/** Scroll the inline approvals into view — the diffs live there, not here. */
function revealApprovals(chatId: number): void {
  const el = document.querySelector(`[data-permission-approvals="${chatId}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function PendingApprovalsBar({ chatId }: { chatId: number }) {
  const queue = useAtomValue(permissionQueueAtom);
  const pending = getOperationsByStatus(queue, "pending");

  if (pending.length === 0) return null;

  return (
    <div className="mx-3 mb-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px]">
      <ShieldQuestion className="size-3 shrink-0 text-amber-500" aria-hidden />
      <span className="truncate flex-1 text-foreground" title={describePending(pending)}>
        {describePending(pending)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-[11px]"
        onClick={() => revealApprovals(chatId)}
      >
        Review
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-6 shrink-0 px-2 text-[11px]"
        // Covers the rest of the TURN, not just what is queued right now.
        //
        // A one-shot drain did not match what people meant by pressing this: it
        // cleared the queue, the model issued its next command, and the prompt
        // came straight back — so a research turn (curl, then python3, then jq,
        // each of which trips the danger gate on its first token) had to be
        // approved once per command. "Always allow" does not help there either,
        // because for a dangerous command it is keyed to that exact command.
        //
        // Still saves NO rule: the blanket lives on the per-turn interceptor and
        // dies with the turn, so one click cannot become a standing grant.
        onClick={() =>
          void IpcClient.getInstance().approveAllForTurn({ chatId })
        }
        title="Approve these and anything else this turn asks for. Ends when the turn ends."
      >
        Allow all this turn
      </Button>
    </div>
  );
}
