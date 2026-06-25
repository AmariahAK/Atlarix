/**
 * A3 — the calm "parked" chip.
 *
 * When a turn ENDS with background work still outstanding, runAgentTurn marks
 * the turn `parked` and useStreamChat sets `parkedWaitingByChatIdAtom`. The turn
 * is genuinely over (the input is live, the send button is shown) — this chip
 * just reassures the user that a fresh turn will resume on its own when an item
 * reports. Dismissing it is cosmetic (the background work keeps running and
 * still auto-resumes); it only hides the reassurance.
 */
import { useAtom } from "jotai";
import { Hourglass } from "lucide-react";
import { parkedWaitingByChatIdAtom } from "@/atoms/chatAtoms";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function describe(commands: number, subagents: number): string {
  const parts: string[] = [];
  if (commands > 0) parts.push(plural(commands, "background task"));
  if (subagents > 0) parts.push(plural(subagents, "sub-agent"));
  const what = parts.length > 0 ? parts.join(" and ") : "background work";
  return `Waiting on ${what} — will resume automatically`;
}

export function ParkedWaitingChip({ chatId }: { chatId: number }) {
  const [parkedByChatId, setParkedByChatId] = useAtom(parkedWaitingByChatIdAtom);
  const parked = parkedByChatId.get(chatId);
  if (!parked) return null;

  return (
    <div className="mx-3 mb-1 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
      <Hourglass className="size-3 shrink-0 animate-pulse" aria-hidden />
      <span className="truncate flex-1">
        {describe(parked.commands, parked.subagents)}
      </span>
      <button
        type="button"
        className="shrink-0 hover:text-foreground"
        title="Stop showing this (the work keeps running and still resumes)"
        onClick={() =>
          setParkedByChatId((prev) => {
            const n = new Map(prev);
            n.delete(chatId);
            return n;
          })
        }
      >
        ×
      </button>
    </div>
  );
}
