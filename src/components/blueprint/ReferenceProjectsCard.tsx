/**
 * Reference projects for combined blueprint (v3.6). List, add, remove paths.
 */

import React, { useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { FolderPlus, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/lib/toast";

interface ReferenceProjectsCardProps {
  workspaceId: number | null;
}

export function ReferenceProjectsCard({ workspaceId }: ReferenceProjectsCardProps) {
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (workspaceId == null) return;
    setLoading(true);
    try {
      const r = await IpcClient.getInstance().getReferencePaths(workspaceId);
      if (r.success && r.paths) setPaths(r.paths);
      else setPaths([]);
    } catch {
      setPaths([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [workspaceId]);

  const remove = async (path: string) => {
    if (workspaceId == null) return;
    const next = paths.filter((p) => p !== path);
    const r = await IpcClient.getInstance().setReferencePaths(workspaceId, next);
    if (r.success) {
      setPaths(next);
      showSuccess("Reference removed");
    } else showError(r.error ?? "Failed to update");
  };

  const add = async () => {
    if (workspaceId == null) return;
    const r = await IpcClient.getInstance().selectAppFolder();
    if (!r?.path) return;
    const next = paths.includes(r.path) ? paths : [...paths, r.path];
    const res = await IpcClient.getInstance().setReferencePaths(workspaceId, next);
    if (res.success) {
      setPaths(next);
      showSuccess("Reference project added");
    } else showError(res.error ?? "Failed to add");
  };

  if (workspaceId == null) return null;

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">Reference projects</span>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={add} disabled={loading}>
          <FolderPlus size={14} className="mr-1" />
          Add
        </Button>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : paths.length === 0 ? (
        <p className="text-xs text-muted-foreground">No reference projects. Add paths for combined blueprint.</p>
      ) : (
        <ul className="space-y-1">
          {paths.map((p) => (
            <li key={p} className="flex items-center gap-2 text-xs">
              <span className="truncate flex-1" title={p}>{p}</span>
              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => remove(p)}>
                <Trash2 size={12} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
