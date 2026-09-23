/**
 * The one-time OK for Atlarix Auto.
 *
 * Auto is free because OpenAI gives complimentary tokens for traffic that is
 * shared with it to improve its models. That trade has to be the user's choice,
 * made knowingly, before their first Auto message — so it is asked here, in
 * plain words, and main refuses to dispatch Auto without the recorded answer
 * (get_model_client), so a saved selection can never skip it.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function AtlarixAutoConsentDialog({
  open,
  onAccept,
  onCancel,
}: {
  open: boolean;
  onAccept: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Use Atlarix Auto for free?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                Atlarix Auto costs nothing. It is free because the prompts and
                replies it handles are shared with OpenAI, which may use them to
                improve its models.
              </p>
              <p>
                Don't use it for code or data you can't share. Every other model
                — Core tiers and your own API keys — is not shared.
              </p>
              <p className="text-muted-foreground">
                Everyone gets a fair daily share; when yours is used, Auto moves
                to a free fallback model, then pauses until the daily reset.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={onAccept}>Use Atlarix Auto</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
