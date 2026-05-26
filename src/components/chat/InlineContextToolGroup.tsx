import { CollapsedScrollSection } from "./CollapsedScrollSection";
import { InlineToolPartCard } from "./InlineToolPartCard";
import type { ToolMessagePart } from "@/lib/chat/display-parts-group";

function contextSummary(tools: ToolMessagePart[]): string {
  const read = tools.filter((t) => t.toolName === "read_file").length;
  const search = tools.filter((t) =>
    ["search_code", "search", "grep", "structural_search"].includes(t.toolName),
  ).length;
  const explore = tools.filter((t) =>
    ["get_repo_overview", "explore_folder", "list_files", "get_blueprint"].includes(
      t.toolName,
    ),
  ).length;
  const bits: string[] = [];
  if (explore > 0) bits.push(`${explore} explore`);
  if (read > 0) bits.push(`${read} read`);
  if (search > 0) bits.push(`${search} search`);
  const detail = bits.length > 0 ? bits.join(" · ") : `${tools.length} tools`;
  return `Gathered context · ${detail}`;
}

export function InlineContextToolGroup({
  tools,
  defaultCollapsed = true,
}: {
  tools: ToolMessagePart[];
  defaultCollapsed?: boolean;
}) {
  if (tools.length === 0) return null;

  return (
    <CollapsedScrollSection
      summary={contextSummary(tools)}
      status="done"
      defaultCollapsed={defaultCollapsed}
      maxBodyHeightClass="max-h-96"
    >
      <div className="space-y-1.5">
        {tools.map((tool) => (
          <InlineToolPartCard
            key={tool.id}
            part={tool}
            defaultCollapsed
          />
        ))}
      </div>
    </CollapsedScrollSection>
  );
}
