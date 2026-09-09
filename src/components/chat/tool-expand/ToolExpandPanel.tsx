import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ToolDiffExpand } from "./ToolDiffExpand";
import { ToolFileListExpand } from "./ToolFileListExpand";
import { ToolMatchListExpand } from "./ToolMatchListExpand";
import { ToolReadSnippetExpand } from "./ToolReadSnippetExpand";
import { ToolSearchResultsExpand } from "./ToolSearchResultsExpand";
import { ToolMcpServersExpand } from "./ToolMcpServersExpand";
import { ToolMcpResultExpand } from "./ToolMcpResultExpand";
import { ToolMcpAuthExpand } from "./ToolMcpAuthExpand";
import { ToolTableExpand } from "./ToolTableExpand";
import { ToolBrowserScreenshotExpand } from "./ToolBrowserScreenshotExpand";
import { ToolBrowserRecordingExpand } from "./ToolBrowserRecordingExpand";
import { ToolCommandExpand } from "./ToolCommandExpand";
import { ToolScrollableBody } from "./ToolScrollableBody";
import { AtlarixMarkdownSegment } from "../AtlarixMarkdownSegment";
import { cn } from "@/lib/utils";

export function ToolExpandPanel({
  view,
  className,
}: {
  view: ToolExpandView;
  className?: string;
}) {
  if (view.kind === "none") return null;

  return (
    <div className={cn("border-t border-border px-2.5 py-2", className)}>
      {view.kind === "file_list" ? <ToolFileListExpand view={view} /> : null}
      {view.kind === "match_list" ? <ToolMatchListExpand view={view} /> : null}
      {view.kind === "read_snippet" ? (
        <ToolReadSnippetExpand view={view} />
      ) : null}
      {view.kind === "diff" ? <ToolDiffExpand view={view} /> : null}
      {view.kind === "search_results" ? (
        <ToolSearchResultsExpand view={view} />
      ) : null}
      {view.kind === "mcp_servers" ? (
        <ToolMcpServersExpand view={view} />
      ) : null}
      {view.kind === "mcp_result" ? <ToolMcpResultExpand view={view} /> : null}
      {view.kind === "mcp_auth" ? <ToolMcpAuthExpand view={view} /> : null}
      {view.kind === "table" ? <ToolTableExpand view={view} /> : null}
      {view.kind === "browser_screenshot" ? (
        <ToolBrowserScreenshotExpand view={view} />
      ) : null}
      {view.kind === "browser_recording" ? (
        <ToolBrowserRecordingExpand view={view} />
      ) : null}
      {view.kind === "command" ? <ToolCommandExpand view={view} /> : null}
      {view.kind === "text" && view.markdown ? (
        // Authored prose (e.g. a sub-agent's report) — headings, lists and fences
        // must render, and `max-w-none` stops the prose container from re-wrapping
        // inside the already-narrow card.
        <div
          className={cn(
            "max-h-96 overflow-y-auto text-xs max-w-none",
            view.isError && "text-destructive",
          )}
        >
          <AtlarixMarkdownSegment content={view.body} isStreaming={false} />
        </div>
      ) : null}
      {view.kind === "text" && !view.markdown ? (
        <ToolScrollableBody
          text={view.body}
          mono={false}
          isError={view.isError}
        />
      ) : null}
    </div>
  );
}
