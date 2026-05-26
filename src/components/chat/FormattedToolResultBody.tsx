import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FormattedToolResult } from "@/lib/chat/format-tool-result";
import { RepoOverviewBody } from "./RepoOverviewBody";

export function FormattedToolResultBody({ formatted }: { formatted: FormattedToolResult }) {
  if (!formatted.body || formatted.bodyKind === "none") return null;

  if (formatted.bodyKind === "repo_overview") {
    return <RepoOverviewBody markdown={formatted.body} />;
  }

  if (formatted.bodyKind === "markdown") {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none text-[11px] leading-snug">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatted.body}</ReactMarkdown>
      </div>
    );
  }

  if (formatted.bodyKind === "json") {
    return (
      <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono">
        {formatted.body}
      </pre>
    );
  }

  return (
    <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap break-words font-mono">
      {formatted.body}
    </pre>
  );
}
