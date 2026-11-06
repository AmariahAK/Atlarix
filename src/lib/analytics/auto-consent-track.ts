/**
 * auto_consent from the main process, the CLI and the editors: through
 * captureSafe, so nothing is sent without the user's yes to analytics. The
 * surface (cli, acp, vscode) comes with every event (superProperties).
 */
import { AUTO_CONSENT_EVENT, autoConsentProperties, type AutoConsentAction, type AutoConsentTrigger } from "./auto-consent-event";

export function trackAutoConsent(action: AutoConsentAction, trigger: AutoConsentTrigger): void {
  void import("@/main/lib/analytics")
    .then((m) => m.captureSafe(AUTO_CONSENT_EVENT, autoConsentProperties(action, trigger)))
    .catch(() => {});
}
