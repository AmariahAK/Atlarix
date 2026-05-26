import { StreamToolCallCard } from "./StreamToolCallCard";
import { InlineFileChangeCard } from "./InlineFileChangeCard";
import { InlineTerminalToolCard } from "./InlineTerminalToolCard";
import { CollapsedScrollSection } from "./CollapsedScrollSection";
import { FormattedToolResultBody } from "./FormattedToolResultBody";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { summarizeInlineTool } from "@/lib/chat/inline-tool-summary";
import { formatToolResultDisplay } from "@/lib/chat/format-tool-result";

const FILE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "search_replace",
  "write_multiple_files",
  "delete_file",
  "rename_file",
]);

const TERMINAL_TOOLS = new Set(["run_command", "execute_command", "stream_terminal_output"]);

export function InlineToolPartCard({
  part,
  defaultCollapsed = true,
}: {
  part: Extract<AssistantMessagePart, { type: "tool" }>;
  defaultCollapsed?: boolean;
}) {
  const formatted = formatToolResultDisplay(part);

  if (FILE_TOOLS.has(part.toolName)) {
    return (
      <InlineFileChangeCard
        toolName={part.toolName}
        summary={formatted.summary}
        status={part.status}
        args={part.args}
        resultText={formatted.body}
        defaultCollapsed={defaultCollapsed}
      />
    );
  }

  if (TERMINAL_TOOLS.has(part.toolName)) {
    return (
      <InlineTerminalToolCard
        summary={formatted.summary}
        status={part.status}
        resultText={formatted.body}
        defaultCollapsed={defaultCollapsed}
      />
    );
  }

  // Default: a collapsible section with markdown-aware body rendering.
  return (
    <CollapsedScrollSection
      summary={formatted.summary}
      status={part.status === "success" ? "done" : part.status}
      defaultCollapsed={defaultCollapsed}
      maxBodyHeightClass="max-h-48"
    >
      <FormattedToolResultBody formatted={formatted} />
    </CollapsedScrollSection>
  );
}
