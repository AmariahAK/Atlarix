/**
 * Generate Blueprints modal (v2.2): list projects with activity recommendation, select and generate.
 */

import { useState, useEffect } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { ProjectCandidate } from "@/lib/blueprint/project-selector";

interface GenerateBlueprintsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: number | null;
  onGenerated?: () => void;
}

export function GenerateBlueprintsModal({
  open,
  onOpenChange,
  workspaceId,
  onGenerated,
}: GenerateBlueprintsModalProps) {
  const [projects, setProjects] = useState<ProjectCandidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || workspaceId == null) return;
    setLoading(true);
    setError(null);
    IpcClient.getInstance()
      .analyzeWorkspaceForBlueprint({ workspaceId })
      .then((res) => {
        if (res.success && res.projects) {
          setProjects(res.projects);
          const defaultSelected = new Set(
            res.projects.filter((p) => p.recommendation === "blueprint" || p.recommendation === "ask_user").map((p) => p.id)
          );
          setSelectedIds(defaultSelected);
        } else {
          setError(res.error ?? "Failed to analyze workspace");
        }
      })
      .finally(() => setLoading(false));
  }, [open, workspaceId]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleGenerate = async () => {
    if (workspaceId == null || selectedIds.size === 0) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await IpcClient.getInstance().generateCombinedBlueprint({
        workspaceId,
        projectIds: Array.from(selectedIds),
      });
      if (res.success) {
        onGenerated?.();
        onOpenChange(false);
      } else {
        setError(res.error ?? "Generate failed");
      }
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Blueprints</DialogTitle>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">Analyzing workspace…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects found in this workspace.</p>
        ) : (
          <div className="space-y-2 max-h-[280px] overflow-auto">
            <p className="text-xs text-muted-foreground">Select projects to include in the blueprint.</p>
            {projects.map((p) => (
              <label
                key={p.id}
                className="flex items-start gap-2 rounded border border-border p-2 cursor-pointer hover:bg-muted/50"
              >
                <Checkbox
                  checked={selectedIds.has(p.id)}
                  onCheckedChange={() => toggle(p.id)}
                />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm">{p.name}</span>
                  <span className="text-muted-foreground text-xs ml-1">({p.language})</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{p.reason}</p>
                </div>
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={loading || generating || selectedIds.size === 0}
          >
            {generating ? "Generating…" : "Generate selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
