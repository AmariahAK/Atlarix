import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { TOOL_PAGE_SIZE } from "@/lib/chat/paginate-tool-runs";
import {
  streamToolCardButton,
  streamToolCardChevron,
} from "./stream-item-styles";

/**
 * Render a run of consecutive tool cards (terminal commands / file changes)
 * paginated: the first `TOOL_PAGE_SIZE` show inline; the rest collapse behind a
 * "Show N more" control and expand into a bounded scroll area so a long run
 * never dominates the page.
 */
export function PaginatedToolCards({
  cards,
  label = "cards",
}: {
  cards: ReactNode[];
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = cards.length;
  const hidden = total - TOOL_PAGE_SIZE;

  if (hidden <= 0) {
    return <>{cards}</>;
  }

  const head = cards.slice(0, TOOL_PAGE_SIZE);
  const rest = cards.slice(TOOL_PAGE_SIZE);

  return (
    <div>
      {head}
      {expanded ? (
        <div className="max-h-[28rem] overflow-auto overscroll-contain">{rest}</div>
      ) : null}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className={cn(streamToolCardButton, "cursor-pointer rounded-md")}
      >
        {expanded ? (
          <ChevronDown className={streamToolCardChevron} />
        ) : (
          <ChevronRight className={streamToolCardChevron} />
        )}
        <span className="text-xs text-muted-foreground">
          {expanded
            ? `Show fewer ${label}`
            : `Show ${hidden} more ${label} (${total} total)`}
        </span>
      </button>
    </div>
  );
}
