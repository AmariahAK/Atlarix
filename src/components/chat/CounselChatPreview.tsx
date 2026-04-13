import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { Loader2 } from "lucide-react";

const COUNSEL_TYPES: ActivityStreamItem["type"][] = [
  "counsel_start",
  "counsel_participant_complete",
  "counsel_synthesising",
  "counsel_complete",
];

function isCounselType(t: ActivityStreamItem["type"]): boolean {
  return COUNSEL_TYPES.includes(t);
}

function roleDisplayName(role: string | undefined): string {
  const r = (role ?? "").toLowerCase();
  if (r === "fast") return "Fast";
  if (r === "balanced") return "Balanced";
  if (r === "thinking") return "Thinking";
  if (r === "synthesis") return "Main";
  if (!r) return "Participant";
  return r.charAt(0).toUpperCase() + r.slice(1);
}

/**
 * WhatsApp-style strip for Counsel: specialist previews on the left,
 * main / synthesis on the right.
 */
export function CounselChatPreview({
  items,
  className,
}: {
  items: ActivityStreamItem[];
  className?: string;
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

  return (
    <div
      className={cn(
        "mt-2 space-y-2 rounded-lg border border-border/50 bg-muted/15 p-2",
        className,
      )}
      aria-label="Counsel session"
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-0.5">
        Counsel
      </div>
      <div className="flex flex-col gap-2">
        {slice.map((it) => {
          if (it.type === "counsel_start") {
            const n = it.participantCount ?? 3;
            return (
              <div
                key={it.id}
                className="self-center max-w-[95%] rounded-md bg-muted/40 px-2 py-1 text-center text-[11px] text-muted-foreground"
              >
                {it.label ?? `Running ${n} perspectives in parallel…`}
              </div>
            );
          }
          if (it.type === "counsel_participant_complete") {
            const title = roleDisplayName(it.counselRole);
            return (
              <div
                key={it.id}
                className="self-start max-w-[min(100%,22rem)] rounded-lg border border-border/40 bg-background/80 px-2.5 py-1.5 text-left text-xs shadow-sm"
              >
                <div className="font-medium text-foreground/90">{title}</div>
                {it.preview ? (
                  <div className="mt-1 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
                    {it.preview}
                    {it.preview.length >= 100 ? "…" : ""}
                  </div>
                ) : null}
              </div>
            );
          }
          if (it.type === "counsel_synthesising") {
            return (
              <div
                key={it.id}
                className="self-end max-w-[min(100%,20rem)] rounded-lg border border-primary/35 bg-primary/8 px-2.5 py-1.5 text-right text-xs text-muted-foreground"
              >
                <div className="flex items-center justify-end gap-1.5 font-medium text-foreground/85">
                  {it.status === "running" ? (
                    <Loader2 className="h-3 w-3 animate-spin shrink-0 text-primary/80" />
                  ) : null}
                  <span>Main · {it.label?.replace(/^Counsel ·\s*/i, "") ?? "Synthesising…"}</span>
                </div>
              </div>
            );
          }
          if (it.type === "counsel_complete") {
            return (
              <div
                key={it.id}
                className="self-end max-w-[min(100%,18rem)] rounded-md border border-border/30 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground"
              >
                {it.label ?? "Counsel complete"}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
