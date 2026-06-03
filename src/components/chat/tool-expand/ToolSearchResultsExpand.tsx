import type { ToolExpandView } from "@/lib/chat/tool-expand-view";
import { ExternalLink } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";

export function ToolSearchResultsExpand({
  view,
}: {
  view: Extract<ToolExpandView, { kind: "search_results" }>;
}) {
  const openInBrowser = (url: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (/^https?:\/\//i.test(url)) {
      void IpcClient.getInstance().openExternalUrl(url);
    }
  };

  return (
    <ul className="space-y-2 max-h-64 overflow-y-auto">
      {view.query ? (
        <li className="text-[10px] text-muted-foreground pb-1">
          Query: {view.query}
        </li>
      ) : null}
      {view.results.map((r) => (
        <li key={r.url} className="text-[11px] leading-snug">
          <a
            href={r.url}
            rel="noreferrer"
            className="inline-flex items-start gap-1 font-medium text-primary hover:underline"
            onClick={(e) => openInBrowser(r.url, e)}
          >
            <ExternalLink className="h-3 w-3 shrink-0 mt-0.5" />
            <span className="break-all">{r.title}</span>
          </a>
          {r.snippet ? (
            <p className="mt-0.5 text-muted-foreground line-clamp-2 pl-4">
              {r.snippet}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
