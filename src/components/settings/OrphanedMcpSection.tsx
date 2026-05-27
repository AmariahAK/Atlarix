import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import type { McpServer } from "@/ipc/ipc_types";
import { showError, showSuccess } from "@/lib/toast";
import { useQueryClient } from "@tanstack/react-query";
import { removeMcpServerFromAllCaches } from "@/hooks/mcpQueryCache";

export function OrphanedMcpSection({
  workspaceAppId: _workspaceAppId,
}: {
  /** Reserved for future: filter orphans tied to a specific workspace */
  workspaceAppId?: number;
} = {}) {
  const queryClient = useQueryClient();
  const [orphans, setOrphans] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const list = (await IpcClient.getInstance().listOrphanedMcpServers()) as McpServer[];
      setOrphans(list ?? []);
    } catch (e) {
      console.warn("[OrphanedMcpSection] Failed to load orphaned MCP servers:", e);
      setOrphans([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onDelete = async (id: number) => {
    setDeletingId(id);
    setOrphans((prev) => prev.filter((s) => s.id !== id));
    removeMcpServerFromAllCaches(queryClient, id);
    try {
      await IpcClient.getInstance().deleteMcpServer(id);
      showSuccess("Unlinked MCP server removed");
      removeMcpServerFromAllCaches(queryClient, id);
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found/i.test(msg)) {
        showSuccess("Unlinked MCP server removed");
        removeMcpServerFromAllCaches(queryClient, id);
        await queryClient.invalidateQueries({ queryKey: ["mcp"] });
        await load();
        return;
      }
      await load();
      showError(msg);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading || orphans.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Unlinked workspace MCP</h3>
        <p className="text-xs text-muted-foreground mt-1">
          These servers were tied to a workspace that no longer exists. Remove them to free slots.
        </p>
      </div>
      <div className="space-y-2">
        {orphans.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-card/50 p-3"
          >
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">{s.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {s.transport}
                {s.appId != null ? ` · former workspace #${s.appId}` : " · no workspace id"}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={deletingId === s.id}
              onClick={() => void onDelete(s.id)}
            >
              {deletingId === s.id ? "Removing…" : "Delete"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
