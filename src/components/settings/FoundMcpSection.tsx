/**
 * MCP servers you already set up in other tools on this computer (Claude Code,
 * Cursor, VS Code, Kiro, Windsurf, Zed, Claude Desktop), each with Add. Added
 * ones join this folder's list, which the app, the CLI and the editors share.
 * Nothing is added without the click.
 */
import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess } from "@/lib/toast";

type Found = Awaited<ReturnType<IpcClient["discoverExternalMcpServers"]>>[number];

export function FoundMcpSection({ appId }: { appId: number }) {
  const queryClient = useQueryClient();
  const [found, setFound] = useState<Found[]>([]);
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFound(await IpcClient.getInstance().discoverExternalMcpServers(appId));
    } catch {
      setFound([]);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!found.length) return null;

  const add = async (s: Found) => {
    setAdding(s.key);
    try {
      await IpcClient.getInstance().importExternalMcpServer(appId, s.key);
      showSuccess(`${s.name} added for this folder.`);
      await queryClient.invalidateQueries({ queryKey: ["mcp"] });
      await load();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Found on this computer</h3>
        <p className="text-xs text-muted-foreground mt-1">Servers you set up in other tools. Add one to use it here, in the CLI and in your editor.</p>
      </div>
      <ul className="divide-y divide-border">
        {found.map((s) => (
          <li key={s.key} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {s.name} <span className="text-xs font-normal text-muted-foreground">· {s.source}{s.scope === "folder" ? ", this folder" : ""}</span>
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground" title={s.summary}>
                {s.summary}
                {s.envNames.length ? ` · ${s.envNames.join(", ")}` : ""}
              </div>
            </div>
            <Button size="sm" variant="outline" disabled={adding === s.key} onClick={() => void add(s)}>
              {adding === s.key ? "Adding…" : "Add"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
