import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { triggerUpgrade, triggerUpgradeWorkforce } from "@/hooks/useUpgrade";

type UpgradeChoiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Lets the user open LemonSqueezy checkout for Pro (solo) or Workforce (teams).
 */
export function UpgradeChoiceDialog({ open, onOpenChange }: UpgradeChoiceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>Choose a plan</DialogTitle>
          <DialogDescription>
            Atlarix Pro is for solo use. Workforce adds team seats, invites, and org billing.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 pt-2">
          <Button
            onClick={() => {
              onOpenChange(false);
              void triggerUpgrade();
            }}
          >
            Atlarix Pro
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
              void triggerUpgradeWorkforce();
            }}
          >
            Atlarix Workforce
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
