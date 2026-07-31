import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FolderOpen } from "lucide-react";

/**
 * "Save to" destination for a clone.
 *
 * The path is TYPEABLE as well as pickable on purpose: the native directory picker is
 * the only way to set a destination in older builds, and when it fails to open (some
 * Linux desktops) the Clone button stays disabled with nothing the user can do about it.
 * Nothing is prefilled — the destination is always the user's explicit choice.
 */
export function CloneDestinationFields({
  value,
  onValueChange,
  error,
  validating,
  destinationPreview,
  onChooseFolder,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  error?: string | null;
  validating?: boolean;
  destinationPreview: string | null;
  onChooseFolder: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3 bg-muted/30">
      <Label htmlFor="clone-destination">Save to</Label>
      <div className="flex gap-2 items-center">
        <Input
          id="clone-destination"
          className="font-mono text-xs"
          placeholder="Type a folder path, or use Choose folder…"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onChooseFolder()}
          disabled={disabled}
          className="flex items-center gap-1 shrink-0"
        >
          <FolderOpen className="h-4 w-4" />
          Choose folder…
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive break-all">{error}</p>
      ) : destinationPreview ? (
        <p className="text-xs text-muted-foreground break-all font-mono">
          {destinationPreview}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {validating
            ? "Checking folder…"
            : "Pick a parent folder. The repo will be cloned into a subfolder with the workspace name."}
        </p>
      )}
    </div>
  );
}
