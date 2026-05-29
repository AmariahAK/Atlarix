import { useMemo } from "react";
import { Users } from "lucide-react";
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
    const rank = (s: SubAgentRunEntry["status"]) =>
      s === "running" ? 0 : s === "done" ? 1 : 2;
    return [...agents].sort(
      (a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id),
    );
  }, [agents]);

  const running = agents.filter((a) => a.status === "running").length;
  const summary =
    running > 0
      ? `Sub-agents · ${running}/${agents.length} running`
      : `Sub-agents · ${agents.length} completed`;

  return (
    <div className={cn(streamToolCardShell, "rounded-lg border my-1.5 overflow-hidden")}>
      <div className={streamToolCardButton}>
        <span className="w-3.5 shrink-0" aria-hidden />
        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={streamToolCardSummary}>{summary}</span>
        {status === "running" ? (
          <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">
            Active
          </span>
        ) : null}
      </div>
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
    </div>
  );
}
