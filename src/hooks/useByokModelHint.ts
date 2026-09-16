/**
 * The one-time hint that points a BYOK user at the model picker.
 *
 * WHAT STATE THIS IS FOR, EXACTLY: the user has supplied their own API key, and the
 * chat is still going to Atlarix Core, because the default model is Core and saving a
 * key never moved it. They are paying Core credit for turns they believe are running
 * on their own key. Nothing in the UI says so.
 *
 * WHY NOT JUST A COMPOSER TIP. There is already a `change-model` tip in
 * `lib/composer-tips.ts`, and it cannot do this job: the pool holds ~17 tips, one is
 * drawn per chat per launch, and `SHOW_PROBABILITY` blanks a third of those draws — so
 * the chance of meeting it in a given chat is around 4%. That is the right design for
 * an ambient rotation and the wrong instrument for someone who is stuck. This fires on
 * a specific broken state, once, and then never again.
 *
 * ALL FOUR CONDITIONS ARE LOAD-BEARING:
 *  - signed in — nothing works signed out, and a hint about models under a sign-in
 *    prompt is noise (the same reason `ComposerTip` suppresses on `mustSignIn`);
 *  - has a BYOK provider — otherwise there is nothing to switch TO, and the honest
 *    advice would be "add a key", which is a different hint;
 *  - currently on Core — if they already picked a BYOK model, nothing is wrong;
 *  - not seen before — persisted in main, so it survives a cleared localStorage.
 */

import { useCallback, useEffect, useState } from "react";

import { useSettings } from "@/hooks/useSettings";
import { useHasByokProvider } from "@/hooks/useHasByokProvider";
import { useAuth } from "@/lib/auth/useAuth";
import { COMPASS_PROVIDER_ID } from "@/ipc/shared/compass_constants";
import {
  hintWasSeen,
  markHintSeen,
  readHintState,
} from "@/lib/onboarding/hint-state";
import { SHORTCUTS, formatCombo, isMacPlatform } from "@/lib/shortcuts";

/**
 * The chord, from the table the conformance test dispatches against — never a
 * literal. `shortcuts-table.test.tsx` both proves this row's handler opens the model
 * sheet and pins `formatCombo` to "⌘J" / "Ctrl+J", so a hint built this way cannot
 * advertise a key the app does not listen for.
 */
function changeModelChord(): string | undefined {
  const row = SHORTCUTS.find((s) => s.id === "change-model");
  return row ? formatCombo(row.combo, isMacPlatform()) : undefined;
}

export interface ByokModelHint {
  showByokHint: boolean;
  dismissByokHint: () => void;
  changeModelChord: string | undefined;
}

export function useByokModelHint(): ByokModelHint {
  const { settings } = useSettings();
  const { isAuthenticated, authResolved } = useAuth();
  const { hasByok, isLoading } = useHasByokProvider();

  const [seen, setSeen] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await readHintState();
      if (!cancelled) setSeen(hintWasSeen(state, "byok-model"));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissByokHint = useCallback(() => {
    // Optimistic: the hint goes away on click, not on the IPC round trip.
    setSeen(true);
    void markHintSeen("byok-model");
  }, []);

  const onCore = settings?.selectedModel?.provider === COMPASS_PROVIDER_ID;

  const showByokHint =
    seen === false &&
    authResolved &&
    isAuthenticated &&
    !isLoading &&
    hasByok &&
    onCore;

  return {
    showByokHint,
    dismissByokHint,
    changeModelChord: changeModelChord(),
  };
}
