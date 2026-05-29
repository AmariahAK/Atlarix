import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2 } from "lucide-react";

export function CloneProgressOverlay({
  visible,
  message,
  progress,
  activeRepo,
  onCancel,
}: {
  visible: boolean;
  message: string;
  progress: number;
  activeRepo?: string | null;
  onCancel: () => void;
}) {
  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 rounded-lg bg-background/90 p-6 backdrop-blur-sm">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      {activeRepo ? (
        <p className="text-sm font-medium text-center">{activeRepo}</p>
      ) : null}
      <p className="text-sm text-muted-foreground text-center">{message}</p>
      <Progress value={progress} className="w-full max-w-xs" />
      <Button type="button" variant="outline" size="sm" onClick={onCancel}>
        Cancel clone
      </Button>
    </div>
  );
}
