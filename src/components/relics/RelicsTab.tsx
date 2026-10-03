/**
 * Relics tab (right panel): every page the agent made to share, the app's
 * version of the CLI's /relics. Hosted relics (paid Core, signed in) and this
 * workspace's local ones, newest first. Each row is the chat's RelicCard (open,
 * copy, preview), plus share / make private for a hosted one, and delete.
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { Globe, Loader2, Lock, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { currentAppAtom } from "@/atoms/appAtoms";
import { RelicCard } from "@/components/chat/RelicCard";
import { IpcClient } from "@/ipc/ipc_client";
import type { RelicSummary } from "@/lib/relics/relic-store";
import { cn } from "@/lib/utils";

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function RelicsTab() {
  const workspace = useAtomValue(currentAppAtom)?.path ?? null;
  const [relics, setRelics] = useState<RelicSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The relic whose delete was pressed once: a second press deletes it. */
  const [armed, setArmed] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspace) return setRelics([]);
    try {
      setRelics(await IpcClient.getInstance().listRelics(workspace));
    } catch (e) {
      setRelics([]);
      toast.error(e instanceof Error ? e.message : "Couldn't list your relics.");
    }
  }, [workspace]);

  useEffect(() => {
    setRelics(null);
    void load();
  }, [load]);

  const share = async (r: RelicSummary) => {
    const next = r.visibility === "link" ? "private" : "link";
    setBusy(r.id);
    try {
      await IpcClient.getInstance().setRelicVisibility(r.id, next);
      toast.success(next === "link" ? "Anyone with the link can open it now." : "Private again: only you, signed in.");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change sharing.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (r: RelicSummary) => {
    if (armed !== r.id) {
      setArmed(r.id);
      setTimeout(() => setArmed((a) => (a === r.id ? null : a)), 3000);
      return;
    }
    setArmed(null);
    setBusy(r.id);
    try {
      await IpcClient.getInstance().deleteRelic({ id: r.id, hosted: r.hosted, path: r.path });
      toast.success(`Deleted “${r.title}”.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't delete it.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="relics-tab">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-sm font-medium">Relics</div>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
          title="Refresh"
          onClick={() => void load()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {relics === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : relics.length === 0 ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>No relics yet.</p>
            <p className="text-xs">
              A relic is a page Atlarix makes to share: a report, a plan, a design. Ask for one, e.g. “make a relic
              summarising this PR”. On paid Atlarix models it gets a private link you can share; otherwise it is saved
              in this workspace’s .atlarix/relics folder.
            </p>
          </div>
        ) : (
          relics.map((r) => (
            <div key={r.id} className="space-y-1">
              <RelicCard
                relic={r}
                actions={
                  <>
                    {r.hosted ? (
                      <button
                        type="button"
                        disabled={busy === r.id}
                        className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-50"
                        title={r.visibility === "link" ? "Make private" : "Share: anyone with the link"}
                        onClick={() => void share(r)}
                      >
                        {r.visibility === "link" ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy === r.id}
                      className={cn(
                        "rounded p-1 hover:bg-muted disabled:opacity-50",
                        armed === r.id ? "text-destructive" : "text-muted-foreground",
                      )}
                      title={armed === r.id ? "Press again to delete" : "Delete"}
                      onClick={() => void remove(r)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    {armed === r.id ? <span className="text-xs text-destructive">Again to delete</span> : null}
                  </>
                }
              />
              <div className="px-1 text-[11px] text-muted-foreground">
                {r.hosted ? "Hosted" : "Local"} · {ago(r.updatedAt)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
