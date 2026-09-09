/**
 * "The model behind your Core slot changed" — the decision, kept pure.
 *
 * WHY A NOTICE EXISTS AT ALL. A Core slot names a SLOT, not a model, and which model
 * sits behind it is `core-models.json`'s business — it changes without an app update
 * and has done so silently before (`core-3` went DeepSeek V4 Pro → Sol → Astra). That
 * indirection is the point of the design, but it means a user's per-turn cost can
 * change several-fold while their selection reads exactly the same. Astra is roughly
 * five times Terra. Telling them once is the least we can do.
 *
 * WHY IT COMPARES THE RESOLVED MODEL ID AND NOT THE TIER→MODEL MAP. A map comparison
 * answers "did the lineup change?", which is the wrong question — it MISSES the case
 * where the lineup held still and the user moved, because their tier was substituted
 * or because the new-install default moved to another slot. The resolved id is what
 * the turn actually ran on, so comparing it catches every way the answer can change:
 *
 *   - a slot reassigned in config      (core-3: Sol → Astra)
 *   - the new-user default tier moved   (core-1 → core-3)
 *   - a saved tier dropped and substituted forward
 *
 * WHY THE BASELINE IS ALSO THE DISMISSAL STATE. Acknowledging advances the baseline to
 * the current model, after which `baseline === current` and the notice cannot fire
 * again for that change. One piece of persisted state instead of a stored baseline plus
 * a separate dismissed-ids list — two stores for one decision is how they drift apart,
 * and a stale dismissal would suppress a notice about a LATER change the user never saw.
 */

import {
  COMPASS_PROVIDER_ID,
  getCoreModelIdForCoreTier,
  resolveConfiguredCoreTier,
} from "@/ipc/shared/compass_constants";

/** What the renderer needs to render the notice. */
export type CoreSlotChange = {
  /** Resolved model id the user was last known to be on. */
  from: string;
  /** Resolved model id they are on now. */
  to: string;
};

/**
 * The model id a selection actually resolves to right now, or null when the user is
 * not on Core at all.
 *
 * Deliberately routed through `resolveConfiguredCoreTier` — the same fall-forward the
 * turn uses — so a selection pointing at a dropped slot reports the model that will
 * really answer, not the one that has gone.
 */
export function effectiveCoreModelId(
  selected: { provider?: string; name?: string } | undefined | null,
): string | null {
  if (!selected || selected.provider !== COMPASS_PROVIDER_ID) return null;
  if (!selected.name) return null;
  const resolved = resolveConfiguredCoreTier(selected.name);
  if (!resolved) return null;
  return getCoreModelIdForCoreTier(resolved.tier)?.trim() || null;
}

/**
 * Whether to tell this user their Core model changed.
 *
 * Returns null — say nothing — in three cases, each for its own reason:
 *
 *  - **Not on Core.** A BYOK user's model did not change; the lineup is irrelevant.
 *  - **No baseline.** A fresh install, or the first launch after this feature shipped.
 *    Notifying here would announce a change the user never experienced, which is the
 *    exact reasoning already recorded for `appLanguage` having no default: absent must
 *    mean "no opinion yet", not "assume one". The caller SEEDS the baseline instead.
 *  - **Unchanged.** Includes the post-acknowledgement state, which is what makes this
 *    fire once rather than every launch.
 */
export function computeCoreSlotChange(
  baseline: string | undefined | null,
  current: string | null,
): CoreSlotChange | null {
  if (!current) return null;
  const from = baseline?.trim();
  if (!from) return null;
  if (from === current) return null;
  return { from, to: current };
}
