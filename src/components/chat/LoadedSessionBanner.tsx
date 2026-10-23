import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { loadedSessionTruncatedAtom } from "@/atoms/sessionAtoms";

/**
 * One muted line when an older session was loaded with only its recent messages.
 * A fact about what is on screen, so nothing to dismiss (it was a boxed notice with
 * a close button until 15.11).
 */
export function LoadedSessionBanner() {
  const truncated = useAtomValue(loadedSessionTruncatedAtom);
  const { t } = useTranslation("chat");
  if (!truncated) return null;
  return (
    <p className="mx-4 mb-1 text-center text-[11px] text-muted-foreground" data-testid="loaded-session-marker">
      {t("loadedSession.olderNotShown")}
    </p>
  );
}
