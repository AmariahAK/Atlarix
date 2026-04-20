import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CompletedTurnArtifacts } from "@/atoms/chatAtoms";

function triggerLabel(t: string): string {
  const map: Record<string, string> = {
    user_command: "Explicit /counsel",
    auto_complex: "Auto (substantive prompt)",
    agent_blocker: "Mid-task",
    low_confidence: "Low confidence",
    deep_think_fallback: "Deep think (counsel substitute)",
  };
  return map[t] ?? t;
}

export function TurnArtifactsCards({ artifacts }: { artifacts: CompletedTurnArtifacts }) {
  const [counselOpen, setCounselOpen] = useState(false);
  const [busOpen, setBusOpen] = useState(false);
  const { counsel, agentBus } = artifacts;
  const hasBus = agentBus.length > 0;
  if (!counsel && !hasBus) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {counsel ? (
        <div className="rounded-md border border-border/60 bg-muted/20 text-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setCounselOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40"
          >
            <span>Counsel</span>
            {counselOpen ? (
              <ChevronUp className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
          {counselOpen && (
            <div className="px-3 py-2 border-t border-border/50 text-xs space-y-2 text-muted-foreground">
              <div>
                <span className="font-medium text-foreground/90">Trigger: </span>
                {triggerLabel(String(counsel.trigger))}
              </div>
              {counsel.participantPreviews.length > 0 ? (
                <ul className="list-disc pl-4 space-y-1">
                  {counsel.participantPreviews.map((p, i) => (
                    <li key={`${p.role}-${i}`}>
                      <span className="font-medium text-foreground/85">{p.role}</span>
                      {p.preview ? `: ${p.preview}` : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {counsel.synthesisSnippet ? (
                <div>
                  <div className="font-medium text-foreground/85 mb-0.5">Synthesis</div>
                  <div className="whitespace-pre-wrap break-words">{counsel.synthesisSnippet}</div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {hasBus ? (
        <div className="rounded-md border border-border/60 bg-muted/20 text-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setBusOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40"
          >
            <span>Agentic-Bus</span>
            {busOpen ? (
              <ChevronUp className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            )}
          </button>
          {busOpen && (
            <ul className="px-3 py-2 border-t border-border/50 text-xs space-y-1.5 text-muted-foreground max-h-48 overflow-y-auto">
              {agentBus.map((ex) => (
                <li key={ex.id} className="border-b border-border/30 last:border-0 pb-1.5 last:pb-0">
                  <div className="text-[10px] opacity-70">
                    {ex.fromAgent ?? "?"} → {ex.toAgent ?? "?"}
                  </div>
                  <div className="text-foreground/90">{ex.label}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
