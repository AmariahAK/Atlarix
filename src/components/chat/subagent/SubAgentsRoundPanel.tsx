import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubAgentRunEntry, StreamThreadToolStatus } from "@/lib/chat/stream-thread";
import { SubAgentRunCard } from "./SubAgentRunCard";
import {
  streamCardScrollBody,
  streamToolCardButton,
  streamToolCardShell,
  streamToolCardSummary,
} from "../stream-item-styles";

export function SubAgentsRoundPanel({
  agents,
  status,
  isStreaming,
  isHistorical = false,
}: {
  agents: SubAgentRunEntry[];
  status: StreamThreadToolStatus;
  isStreaming: boolean;
  isHistorical?: boolean;
}) {
  const sortedAgents = useMemo(() => {
    // Active first (anything not yet settled), then done, then errors.
    const rank = (s: SubAgentRunEntry["status"]) =>
      s === "done" ? 1 : s === "error" ? 2 : 0;
    return [...agents].sort(
      (a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id),
    );
  }, [agents]);

  // Mirror the card icons: only an explicit "done"/"error" counts as settled.
  // Counting "not running" as completed made the header claim "N completed"
  // while agents were still spinning up.
  const settled = agents.filter(
    (a) => a.status === "done" || a.status === "error",
  ).length;
  const active = agents.length - settled;
  const allSettled = agents.length > 0 && active === 0;
  const summary =
    active > 0
      ? `Sub-agents · ${active}/${agents.length} running`
      : `Sub-agents · ${agents.length} completed`;

  /**
   * Collapse once every agent has settled.
   *
   * A sub-agent's report is written for the PARENT AGENT, not for the reader — it's
   * data passed between models. While the round is live, the open list is the point:
   * it's how you see what's happening. Once it's finished, keeping every report
   * expanded buries the actual answer under machine-to-machine output, so the panel
   * folds back to its one-line summary and the cards stay one click away.
   *
   * Live rounds are never auto-collapsed, and a user who opens a settled round keeps
   * it open (`userToggled`) — re-collapsing under someone reading it would be worse
   * than never collapsing at all.
   *
   * `!isStreaming` is load-bearing, not belt-and-braces. `allSettled` flips the moment
   * the LAST sub-agent finishes, which is usually mid-turn — the agent keeps working
   * afterwards. Collapsing on that alone unmounted a body up to `min-h-[14rem]` tall
   * while the stream was still appending, so the document height dropped and everything
   * below jumped under the auto-scroll. That is the "scratchy" rendering. Waiting for
   * the turn to end reaches the same collapsed state with no reflow mid-stream.
   */
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? !(allSettled && !isStreaming);

  return (
    <div className={cn(streamToolCardShell, "rounded-lg border my-1.5 overflow-hidden")}>
      <button
        type="button"
        className={cn(streamToolCardButton, "w-full cursor-pointer text-left")}
        onClick={() => setUserToggled(!expanded)}
        aria-expanded={expanded}
      >
        <span className="w-3.5 shrink-0" aria-hidden />
        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={streamToolCardSummary}>{summary}</span>
        {status === "running" ? (
          <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">
            Active
          </span>
        ) : null}
        {expanded ? (
          <ChevronUp className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", status !== "running" && "ml-auto")} />
        ) : (
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", status !== "running" && "ml-auto")} />
        )}
      </button>
      {expanded ? (
        <div
          className={cn(
            streamCardScrollBody,
            "flex flex-col gap-2 px-2 pb-2",
            agents.length > 3 && "min-h-[14rem]",
          )}
        >
          {sortedAgents.map((agent) => (
            <SubAgentRunCard
              key={agent.id}
              agent={agent}
              isStreaming={isStreaming}
              isHistorical={isHistorical}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
