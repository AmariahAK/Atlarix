import { Loader2 } from "lucide-react";

export function ArtifactStreamingOverlay({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
      <span>{label}</span>
    </div>
  );
}
