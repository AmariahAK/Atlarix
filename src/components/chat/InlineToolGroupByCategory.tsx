import { CollapsedScrollSection } from "./CollapsedScrollSection";
import { StreamToolCallCard } from "./StreamToolCallCard";
import type { StreamThreadItem } from "@/lib/chat/stream-thread";

export function InlineToolGroupByCategory({
  group,
  defaultCollapsed = true,
}: {
  group: Extract<StreamThreadItem, { kind: "tool_group" }>;
  defaultCollapsed?: boolean;
}) {
  return (
    <CollapsedScrollSection
      summary={group.summary}
      status={group.status}
      defaultCollapsed={defaultCollapsed}
      maxBodyHeightClass="max-h-72"
    >
      <div className="space-y-1">
        {group.tools.map((tool) => (
          <StreamToolCallCard
            key={`${tool.id}-${tool.ts}`}
            summary={tool.summary}
            expand={tool.expand}
            detail={tool.detail}
            status={tool.status}
            toolName={tool.toolName}
          />
        ))}
      </div>
    </CollapsedScrollSection>
  );
}
