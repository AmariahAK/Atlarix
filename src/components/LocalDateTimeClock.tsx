import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type DateTimeParts = {
  dateLine: string;
  timeLine: string;
  timeZoneShort: string;
  timeZoneId: string;
};

function getDateTimeParts(now: Date): DateTimeParts {
  const timeZoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateLine = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const timeLine = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(now);
  const timeZoneShort =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZoneId;

  return { dateLine, timeLine, timeZoneShort, timeZoneId };
}

type LocalDateTimeClockProps = {
  variant?: "welcome" | "compact";
  className?: string;
  /** Defaults to 1s (welcome) or 30s (compact). */
  tickMs?: number;
};

export function LocalDateTimeClock({
  variant = "compact",
  className,
  tickMs,
}: LocalDateTimeClockProps) {
  const [parts, setParts] = useState(() => getDateTimeParts(new Date()));
  const interval = tickMs ?? (variant === "welcome" ? 1000 : 30_000);

  useEffect(() => {
    const update = () => setParts(getDateTimeParts(new Date()));
    update();
    const id = window.setInterval(update, interval);
    return () => window.clearInterval(id);
  }, [interval]);

  const title = `${parts.dateLine} ${parts.timeLine} — ${parts.timeZoneShort} (${parts.timeZoneId})`;

  if (variant === "welcome") {
    return (
      <div
        className={cn("text-center tabular-nums w-full", className)}
        aria-live="polite"
        title={title}
      >
        <p className="text-sm text-muted-foreground">{parts.dateLine}</p>
        <p className="text-lg font-medium tracking-tight text-foreground mt-0.5">
          {parts.timeLine}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {parts.timeZoneShort}
          <span className="mx-1 opacity-40">·</span>
          <span className="font-mono">{parts.timeZoneId}</span>
        </p>
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-6 w-6 p-0 shrink-0", className)}
          aria-label={title}
        >
          <Clock className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="tabular-nums max-w-xs"
        aria-live="polite"
      >
        <p className="text-xs">{parts.dateLine}</p>
        <p className="text-xs font-medium">{parts.timeLine}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {parts.timeZoneShort}
          <span className="opacity-50"> · </span>
          <span className="font-mono">{parts.timeZoneId}</span>
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
