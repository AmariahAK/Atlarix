import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FolderOpen } from "lucide-react";

export function CloneDestinationFields({
  targetParentDir,
  destinationPreview,
  onChooseFolder,
  disabled,
}: {
  targetParentDir: string | null;
  destinationPreview: string | null;
  onChooseFolder: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3 bg-muted/30">
      <Label>Save to</Label>
      <div className="flex flex-wrap gap-2 items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onChooseFolder()}
          disabled={disabled}
          className="flex items-center gap-1"
        >
          <FolderOpen className="h-4 w-4" />
          {targetParentDir ? "Change folder…" : "Choose folder…"}
        </Button>
      </div>
      {destinationPreview ? (
        <p className="text-xs text-muted-foreground break-all font-mono">
          {destinationPreview}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Pick a parent folder. The repo will be cloned into a subfolder with the workspace name.
        </p>
      )}
    </div>
  );
}
