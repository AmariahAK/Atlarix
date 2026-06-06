/**
 * v12 2.3 — background agents view. Polls the in-process status map and
 * surfaces running/done/error agents with cancel, open-session, and (write
 * mode) the keep/revert approval gate. All decisions go through IPC; this is
 * a thin renderer.
 */

import { useEffect, useState, useCallback } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { Bot, Loader2, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BackgroundAgent {
  sessionId: string;
  appId: number;
  title: string;
  mode: "ask" | "build";
  status: "running" | "done" | "error";
  startedAt: number;
  error?: string;
  changedFiles?: string[];
  reverted?: boolean;
}

export function AgentsPanel() {
  const [agents, setAgents] = useState<BackgroundAgent[]>([]);

  const refresh = useCallback(() => {
    IpcClient.getInstance()
      .listBackgroundAgents()
      .then((list) => setAgents(list as BackgroundAgent[]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Poll while any agent is running (cheap; the list lives in main memory).
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  const cancel = async (sessionId: string) => {
    await IpcClient.getInstance().cancelBackgroundAgent(sessionId);
    refresh();
  };
  const resolve = async (sessionId: string, decision: "keep" | "revert") => {
    await IpcClient.getInstance().resolveBackgroundAgent(sessionId, decision);
    refresh();
  };

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
        <Bot className="h-6 w-6" />
        <span>No background agents yet.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 overflow-y-auto">
      {agents.map((a) => (
        <div
          key={a.sessionId}
          className="rounded-md border border-border bg-muted/20 p-3 text-sm"
        >
          <div className="flex items-center gap-2">
            {a.status === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />
            ) : a.status === "error" ? (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
            <span className="font-medium truncate flex-1">{a.title}</span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {a.mode}
            </span>
            {a.status === "running" && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                onClick={() => cancel(a.sessionId)}
                title="Cancel agent"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {a.error && <p className="mt-1 text-xs text-amber-600">{a.error}</p>}
          {a.status === "done" &&
            a.mode === "build" &&
            (a.changedFiles?.length ?? 0) > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-muted-foreground">
                  {a.changedFiles!.length} file
                  {a.changedFiles!.length === 1 ? "" : "s"} changed
                  {a.reverted ? " · reverted" : ""}
                </p>
                {!a.reverted && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => resolve(a.sessionId, "keep")}
                    >
                      Keep
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => resolve(a.sessionId, "revert")}
                    >
                      Revert
                    </Button>
                  </div>
                )}
              </div>
            )}
        </div>
      ))}
    </div>
  );
}
