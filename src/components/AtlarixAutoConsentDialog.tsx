/**
 * The one-time OK for Atlarix Auto.
 *
 * FREE Auto is free because OpenAI gives complimentary tokens for traffic that
 * is shared with it to improve its models. That trade has to be the user's
 * choice, made knowingly — so it is asked here, in plain words. Only the free
 * path needs it: an account with Pro or credit gets paid Auto, which is never
 * shared. The app sends `X-Atlarix-Free-Consent` only once this is accepted,
 * and the proxy never serves free Auto without it.
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePostHog } from "posthog-js/react";
import {
  AUTO_CONSENT_EVENT,
  autoConsentProperties,
  type AutoConsentAction,
  type AutoConsentTrigger,
} from "@/lib/analytics/auto-consent-event";
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
  trigger,
  onAccept,
  onCancel,
}: {
  open: boolean;
  /** What opened it, for auto_consent (analytics only, with the user's yes to it). */
  trigger: AutoConsentTrigger;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("chat");
  const posthog = usePostHog();
  // One answer per opening: "Not now" also closes the dialog (onOpenChange).
  const answered = useRef(false);
  const note = (action: AutoConsentAction) =>
    posthog?.capture(AUTO_CONSENT_EVENT, { ...autoConsentProperties(action, trigger), surface: "app" });
  useEffect(() => {
    if (!open) return;
    answered.current = false;
    note("shown");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const answer = (action: "accepted" | "declined") => {
    if (answered.current) return;
    answered.current = true;
    note(action);
  };
  const cancel = () => {
    answer("declined");
    onCancel();
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && cancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("atlarixAuto.consentTitle")}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>{t("atlarixAuto.consentWhy")}</p>
              <p>{t("atlarixAuto.consentCare")}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={cancel}>
            {t("atlarixAuto.consentCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              answer("accepted");
              onAccept();
            }}
          >
            {t("atlarixAuto.consentAccept")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
