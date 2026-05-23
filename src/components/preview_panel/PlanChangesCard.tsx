import { AlertTriangle } from "lucide-react";
import type { PlanChangesPayload, PlanFileAction } from "@/lib/plan-changes/plan-changes";
import { groupChangesByAction } from "@/lib/plan-changes/plan-changes";

const ACTION_LABELS: Record<PlanFileAction, string> = {
  CREATE: "Create",
  MODIFY: "Modify",
  ADD: "Add",
  DELETE: "Delete",
};

const ACTION_ORDER: PlanFileAction[] = ["MODIFY", "CREATE", "ADD", "DELETE"];

export function PlanChangesCard({ changes }: { changes: PlanChangesPayload | null }) {
  if (!changes?.files.length) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        No file changes summary yet. The agent will list affected files before Build.
      </div>
    );
  }

  const grouped = groupChangesByAction(changes.files);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-border font-medium text-sm">What&apos;s changing</div>
      <div className="px-3 py-2 space-y-2 text-sm font-mono">
        {ACTION_ORDER.map((action) => {
          const paths = grouped[action];
          if (!paths.length) return null;
          return (
            <div key={action}>
              <div className="text-xs font-sans font-semibold text-muted-foreground mb-1">
                {ACTION_LABELS[action]}
              </div>
              <ul className="space-y-0.5">
                {paths.map((p) => (
                  <li key={`${action}-${p}`} className="truncate" title={p}>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      {changes.risks && changes.risks.length > 0 ? (
        <div className="px-3 py-2 border-t border-border bg-amber-500/5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Risks
          </div>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
            {changes.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
