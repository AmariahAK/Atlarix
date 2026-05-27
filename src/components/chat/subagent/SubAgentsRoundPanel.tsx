import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubAgentRunEntry, StreamThreadToolStatus } from "@/lib/chat/stream-thread";
import { SubAgentRunCard } from "./SubAgentRunCard";
import {
  streamToolCardButton,
  streamToolCardChevron,
  streamToolCardShell,
  streamToolCardSummary,
} from "../stream-item-styles";

export function SubAgentsRoundPanel({
  agents,
  status,
  isStreaming,
}: {
  agents: SubAgentRunEntry[];
  status: StreamThreadToolStatus;
  isStreaming: boolean;
}) {
  const sortedAgents = useMemo(() => {
    const rank = (s: SubAgentRunEntry["status"]) =>
      s === "running" ? 0 : s === "done" ? 1 : 2;
    return [...agents].sort(
      (a, b) => rank(a.status) - rank(b.status) || a.id.localeCompare(b.id),
    );
  }, [agents]);

  const running = agents.filter((a) => a.status === "running").length;
  const [open, setOpen] = useState(true);
  const summary =
    running > 0
      ? `Sub-agents · ${running}/${agents.length} running`
      : `Sub-agents · ${agents.length} completed`;

  return (
    <div className={cn(streamToolCardShell, "rounded-lg border my-1.5")}>
      <button
        type="button"
        className={streamToolCardButton}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className={streamToolCardChevron} />
        ) : (
          <ChevronRight className={streamToolCardChevron} />
        )}
        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={streamToolCardSummary}>{summary}</span>
        {status === "running" ? (
          <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">
            Active
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          {sortedAgents.map((agent) => (
            <SubAgentRunCard
              key={agent.id}
              agent={agent}
              isStreaming={isStreaming}
              defaultExpanded
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
