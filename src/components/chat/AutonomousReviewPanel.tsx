import { useCallback, useMemo, useState } from "react";
import { useAtom } from "jotai";
import { autonomousSessionReviewAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight } from "lucide-react";

interface AutonomousReviewPanelProps {
  chatId: number | undefined;
}

export function AutonomousReviewPanel({ chatId }: AutonomousReviewPanelProps) {
  const [payload, setPayload] = useAtom(autonomousSessionReviewAtom);
  const [busy, setBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = payload != null && chatId != null && payload.chatId === chatId;

  const ops = payload?.ops ?? [];

  const toggleOp = useCallback((operationId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(operationId)) next.delete(operationId);
      else next.add(operationId);
      return next;
    });
  }, []);

  const fileLikeOps = useMemo(
    () =>
      ops.filter(
        (o) =>
          o.path &&
          !/^(npm |yarn |pnpm |npx )/i.test(o.path) &&
          o.type !== "run_command",
      ),
    [ops],
  );

  const handleAcceptAll = useCallback(async () => {
    if (!payload || chatId == null) return;
    setBusy(true);
    try {
      await IpcClient.getInstance().autonomousAcceptAll({
        chatId: payload.chatId,
        turnId: payload.turnId,
      });
      setPayload(null);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }, [payload, chatId, setPayload]);

  const handleRevertSelected = useCallback(async () => {
    if (!payload || chatId == null || selected.size === 0) return;
    setBusy(true);
    try {
      const ipc = IpcClient.getInstance();
      for (const operationId of selected) {
        await ipc.autonomousRevertOp({
          chatId: payload.chatId,
          turnId: payload.turnId,
          operationId,
        });
      }
      setSelected(new Set());
      setPayload((p) =>
        p
          ? {
              ...p,
              ops: p.ops.map((o) =>
                selected.has(o.operationId) ? { ...o, reverted: true } : o,
              ),
            }
          : null,
      );
    } finally {
      setBusy(false);
    }
  }, [payload, chatId, selected, setPayload]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        "mx-4 mb-3 rounded-lg border border-border/80 bg-muted/40 p-4 text-sm",
        "dark:bg-muted/25",
      )}
    >
      <h3 className="font-medium text-foreground mb-1">
        Autonomous session complete — review changes before continuing
      </h3>
      <p className="text-muted-foreground text-xs mb-3">
        Operations ran without per-step approval. Revert individual files from this turn&apos;s
        workspace snapshot if needed.
      </p>

      <div className="space-y-2 mb-3">
        <div className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          Changes made
        </div>
        {fileLikeOps.length === 0 ? (
          <p className="text-muted-foreground text-xs">No file paths in session log (commands only).</p>
        ) : (
          <ul className="space-y-2 max-h-48 overflow-y-auto">
            {fileLikeOps.map((op) => (
              <li
                key={op.operationId}
                className="flex items-start gap-2 rounded border border-border/50 bg-background/60 p-2"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(op.operationId)}
                  onChange={() => toggleOp(op.operationId)}
                  disabled={op.reverted || busy}
                  aria-label={`Revert ${op.path}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs truncate">{op.path}</div>
                  <div className="text-xs text-muted-foreground">
                    {op.type}
                    {op.reverted ? " · reverted" : ""}
                    {op.result === "failed" ? " · failed" : ""}
                  </div>
                  {op.summary ? (
                    <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words max-h-24 overflow-y-auto bg-muted/50 p-1 rounded">
                      {op.summary.slice(0, 800)}
                    </pre>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-3">
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          onClick={() => setActivityOpen((v) => !v)}
        >
          {activityOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Agent activity ({payload.agentActivity.length})
        </button>
        {activityOpen ? (
          <ul className="mt-2 max-h-40 overflow-y-auto space-y-1 text-xs text-muted-foreground border border-border/40 rounded p-2 bg-background/40">
            {(payload.agentActivity as Record<string, unknown>[]).map((row, i) => (
              <li key={i} className="font-mono break-all">
                {(row.from as string) ?? "?"} → {(row.to as string) ?? "?"}:{" "}
                {(row.type as string) ?? "?"}
                {typeof row.content === "string" && row.content
                  ? ` — ${String(row.content).slice(0, 120)}`
                  : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="default" disabled={busy} onClick={handleAcceptAll}>
          Accept all
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || selected.size === 0}
          onClick={handleRevertSelected}
        >
          Revert selected
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setPayload(null)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
