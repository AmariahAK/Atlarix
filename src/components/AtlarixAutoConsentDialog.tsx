/**
 * The one-time OK for Atlarix Auto.
 *
 * Auto is free because OpenAI gives complimentary tokens for traffic that is
 * shared with it to improve its models. That trade has to be the user's choice,
 * made knowingly, before their first Auto message — so it is asked here, in
 * plain words, and main refuses to dispatch Auto without the recorded answer
 * (get_model_client), so a saved selection can never skip it.
 */
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("chat");
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("atlarixAuto.consentTitle")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>{t("atlarixAuto.consentWhy")}</p>
              <p>{t("atlarixAuto.consentCare")}</p>
              <p className="text-muted-foreground">
                {t("atlarixAuto.consentShare")}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            {t("atlarixAuto.consentCancel")}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onAccept}>
            {t("atlarixAuto.consentAccept")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
