/**
 * Live vs Blueprint comparison — side-by-side view of code-derived structure vs current blueprint.
 */

import { useState, useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import type { Blueprint } from "@/shared/blueprint-types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GitCompare } from "lucide-react";

interface LiveVsBlueprintCompareProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBlueprint: Blueprint;
}

export function LiveVsBlueprintCompare({
  open,
  onOpenChange,
  currentBlueprint,
}: LiveVsBlueprintCompareProps) {
  const app = useAtomValue(currentAppAtom);
  const [liveNodes, setLiveNodes] = useState<Array<{ id: string; type: string; label: string }>>([]);
  const [liveEdges, setLiveEdges] = useState<Array<{ fromId: string; toId: string }>>([]);
  const [loading, setLoading] = useState(false);

  const loadLive = useCallback(async () => {
    if (!app?.id) return;
    setLoading(true);
    try {
      const res = await IpcClient.getInstance().getPivotNodesEdges({ workspaceId: app.id });
      if (res.success && res.nodes) {
        setLiveNodes(res.nodes);
        setLiveEdges(res.edges ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [app?.id]);

  useEffect(() => {
    if (open && app?.id) loadLive();
  }, [open, app?.id, loadLive]);

  const liveContainerLabels = Array.from(
    new Set(
      liveNodes
        .filter((n) => n.type === "file")
        .map((n) => n.label),
    ),
  ).slice(0, 30);
  const blueprintRoomLabels = currentBlueprint.rooms.map((r) => r.label);
  const onlyInLive = liveContainerLabels.filter((l) => !blueprintRoomLabels.includes(l));
  const onlyInBlueprint = blueprintRoomLabels.filter((l) => !liveContainerLabels.includes(l));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col gap-4" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompare className="w-4 h-4" />
            Live vs Blueprint
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Left: structure from code (files/nodes). Right: current blueprint (containers). Differences are highlighted.
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading live structure…</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 overflow-auto min-h-0">
            <div className="border rounded-md p-3 bg-muted/20">
              <h4 className="text-xs font-semibold text-muted-foreground mb-2">Live (from code)</h4>
              <ul className="text-xs space-y-1">
                {liveContainerLabels.length === 0 && (
                  <li className="text-muted-foreground">No nodes. Run Refresh from code first.</li>
                )}
                {liveContainerLabels.map((l) => (
                  <li
                    key={l}
                    className={onlyInLive.includes(l) ? "text-amber-600 font-medium" : ""}
                  >
                    {l}
                  </li>
                ))}
              </ul>
            </div>
            <div className="border rounded-md p-3 bg-muted/20">
              <h4 className="text-xs font-semibold text-muted-foreground mb-2">Blueprint (current)</h4>
              <ul className="text-xs space-y-1">
                {blueprintRoomLabels.length === 0 && (
                  <li className="text-muted-foreground">No containers.</li>
                )}
                {blueprintRoomLabels.map((l) => (
                  <li
                    key={l}
                    className={onlyInBlueprint.includes(l) ? "text-blue-600 font-medium" : ""}
                  >
                    {l}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {(onlyInLive.length > 0 || onlyInBlueprint.length > 0) && !loading && (
          <p className="text-xs text-muted-foreground">
            Amber = only in Live. Blue = only in Blueprint.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
