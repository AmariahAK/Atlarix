/**
 * auto_consent: the free Atlarix Auto consent (shown, accepted, declined), what
 * opened it, and the version of its wording. Measures whether it stops people
 * (owner, 2026-11-06); the dialog's words and flow are unchanged.
 *
 * Shared by the app's renderer (posthog-js) and the main process, the CLI and
 * the editors (auto-consent-track.ts). Both send it only with the user's yes to
 * analytics. No imports with side effects: the renderer bundles this file.
 */
import { ATLARIX_AUTO_CONSENT_VERSION } from "@/ipc/shared/compass_constants";

export const AUTO_CONSENT_EVENT = "auto_consent";

export type AutoConsentAction = "shown" | "accepted" | "declined";

/**
 * What opened it: picking Auto in the model picker, a turn free Auto refused,
 * or the one-time re-ask of a yes given to the old wording.
 */
export type AutoConsentTrigger = "picker" | "refused_turn" | "reask";

export function autoConsentProperties(action: AutoConsentAction, trigger: AutoConsentTrigger) {
  return { action, trigger, version: ATLARIX_AUTO_CONSENT_VERSION };
}
