import { HelpCircle } from "lucide-react";
import { useSetAtom } from "jotai";
import { tourFeatureRequestAtom } from "@/atoms/tourAtoms";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type TourFeatureId = "diagram" | "agents" | "extensions" | "db";

export function TourHelpButton({
  featureId,
  label,
  className,
}: {
  featureId: TourFeatureId;
  label?: string;
  className?: string;
}) {
  const setReq = useSetAtom(tourFeatureRequestAtom);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted",
              className,
            )}
            aria-label={label ?? "Tour"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setReq(featureId);
            }}
          >
            <HelpCircle className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="text-xs">{label ?? "Short tour"}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
