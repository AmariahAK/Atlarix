import { useMemo } from "react";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { CollapsedScrollSection } from "./CollapsedScrollSection";

function roleLabel(role: ActivityStreamItem["counselRole"]): string {
  if (role === "fast") return "Fast";
  if (role === "balanced") return "Balanced";
  if (role === "thinking") return "Thinking";
  if (role === "synthesis") return "Main";
  return "Participant";
}

function isCounselType(t: ActivityStreamItem["type"]): boolean {
  return (
    t === "counsel_start" ||
    t === "counsel_participant_complete" ||
    t === "counsel_synthesising" ||
    t === "counsel_complete" ||
    t === "counsel_thinking" ||
    t === "counsel_timeout"
  );
}

export function InlineCounselSection({
  items,
  defaultCollapsed,
}: {
  items: ActivityStreamItem[];
  defaultCollapsed: boolean;
}) {
  const slice = useMemo(() => {
    const counsel = items
      .filter((i) => isCounselType(i.type))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    if (counsel.length === 0) return [];
    const lastStart = counsel.map((i) => i.type).lastIndexOf("counsel_start");
    const from = lastStart >= 0 ? lastStart : 0;
    return counsel.slice(from);
  }, [items]);

  if (slice.length === 0) return null;

  const start = slice.find((i) => i.type === "counsel_start");
  const n = start?.participantCount ?? 3;
  const summary = `Counsel · ${n} perspectives`;

  const running = slice.some((i) => i.status === "running");
  const status = running ? "running" : "done";

  return (
    <CollapsedScrollSection
      summary={summary}
      status={status}
      defaultCollapsed={defaultCollapsed}
      maxBodyHeightClass="max-h-72"
    >
      <div className="space-y-2">
        {slice.map((it) => {
          if (it.type === "counsel_start") {
            return (
              <div key={it.id} className="text-[10px] text-muted-foreground">
                {it.counselTrigger ? `Trigger: ${String(it.counselTrigger)}` : null}
              </div>
            );
          }
          if (it.type === "counsel_thinking") {
            return (
              <div key={it.id} className="rounded-md border border-border/40 bg-background/70 px-2 py-1">
                <div className="text-[10px] font-medium text-foreground/85">
                  {roleLabel(it.counselRole)} · thinking…
                </div>
                {it.detail ? (
                  <div className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
                    {it.detail}
                  </div>
                ) : null}
              </div>
            );
          }
          if (it.type === "counsel_participant_complete") {
            return (
              <div key={it.id} className="rounded-md border border-border/40 bg-background/70 px-2 py-1">
                <div className="text-[10px] font-medium text-foreground/85">
                  {roleLabel(it.counselRole)}
                </div>
                {it.preview ? (
                  <div className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
                    {it.preview}
                  </div>
                ) : null}
              </div>
            );
          }
          if (it.type === "counsel_synthesising") {
            return (
              <div key={it.id} className="rounded-md border border-border/40 bg-muted/10 px-2 py-1">
                <div className="text-[10px] font-medium text-foreground/85">Main · synthesising…</div>
              </div>
            );
          }
          if (it.type === "counsel_complete" || it.type === "counsel_timeout") {
            return it.detail ? (
              <div key={it.id} className="rounded-md border border-border/30 bg-muted/10 px-2 py-1">
                <div className="text-[10px] font-medium text-foreground/85">
                  {it.type === "counsel_timeout" ? "Counsel timed out" : "Counsel complete"}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap break-words">
                  {it.detail}
                </div>
              </div>
            ) : null;
          }
          return null;
        })}
      </div>
    </CollapsedScrollSection>
  );
}

