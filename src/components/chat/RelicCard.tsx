import { useState } from "react";
import { Copy, ExternalLink, FolderOpen, Globe, Loader2 } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import type { RelicView } from "@/lib/relics/relic-result";
import { cn } from "@/lib/utils";

/**
 * A relic in the chat: the page the agent made to share.
 *
 * - Hosted (paid Core): its private atlarix.dev link, to open or copy. The
 *   page itself is viewed there, where its isolation is set up.
 * - Local (your own keys, free Auto): the file in the workspace, with an inline
 *   preview in a sandboxed frame (`allow-scripts` only: an opaque origin, no
 *   access to the app).
 */
export function RelicCard({
  relic,
  actions,
}: {
  /** `visibility`: known in the Relics tab; a relic in the chat starts private. */
  relic: RelicView & { visibility?: "private" | "link" };
  /** Extra buttons (the Relics tab's share and delete). */
  actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !relic.hosted && relic.path && html === null) {
      const res = await IpcClient.getInstance().readLocalRelic(relic.path);
      if ("html" in res) setHtml(res.html);
      else setError(res.error);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(relic.url ?? relic.path ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden" data-testid="relic-card">
      <div className="flex items-center gap-2 px-3 py-2">
        <Globe className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{relic.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {relic.hosted
              ? `${relic.visibility === "link" ? "Anyone with the link" : "Private link"} · ${relic.url}`
              : `Local file · ${relic.path}`}
          </div>
        </div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          title={relic.hosted ? "Copy link" : "Copy path"}
          onClick={() => void copy()}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {relic.hosted && relic.url ? (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            title="Open in your browser"
            onClick={() => void IpcClient.getInstance().openExternalUrl(relic.url!)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        ) : (
          <>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-muted"
              title="Show in folder"
              onClick={() => relic.path && void IpcClient.getInstance().showItemInFolder(relic.path)}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={cn("rounded px-2 py-0.5 text-xs hover:bg-muted", open && "bg-muted")}
              onClick={() => void toggle()}
            >
              {open ? "Hide" : "Preview"}
            </button>
          </>
        )}
        {actions}
        {copied ? <span className="text-xs text-muted-foreground">Copied</span> : null}
      </div>
      {open && !relic.hosted ? (
        <div className="h-[420px] border-t border-border bg-white">
          {html !== null ? (
            <iframe title={relic.title} srcDoc={html} sandbox="allow-scripts" className="h-full w-full border-0" />
          ) : error ? (
            <p className="p-3 text-xs text-muted-foreground">{error}</p>
          ) : (
            <Loader2 className="m-3 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
      ) : null}
    </div>
  );
}
