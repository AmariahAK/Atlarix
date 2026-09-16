/**
 * Read/write the local record of which one-time hints a user has already seen.
 *
 * WHY MAIN-PROCESS JSON AND NOT `localStorage`. Every other dismiss-once flag in the
 * app lives in renderer `localStorage` (`atlarix.hasSeenIntentExplanation`,
 * `atlarix_whats_new_dismissed_*`, `atlarix_update_banner_dismissed_*`). This one does
 * not, and the difference is deliberate: `userData/atlarix-tours.json` survives a
 * cleared site-data store, and onboarding is precisely the thing that must not
 * re-run for an existing user because their renderer storage was wiped. The cost is
 * two IPC round trips, which is irrelevant at the once-per-session rate this is read.
 *
 * The channels are allowlisted in `preload.ts` and handled by
 * `ipc/handlers/tour_handlers.ts` → `main/tour-store.ts`.
 */

export interface HintState {
  firstRunCompleted: boolean;
  firstRunStep: number;
  dismissedAt: string | null;
  featureTours: Record<string, { completed: boolean; step: number }>;
}

/** Ids for the one-time hints. Listed here so a typo is a type error. */
export type HintId = "byok-model" | "guided-tour";

function getInvoke():
  | ((ch: string, ...args: unknown[]) => Promise<unknown>)
  | null {
  return (
    (
      window as unknown as {
        electron?: {
          ipcRenderer?: {
            invoke: (c: string, ...a: unknown[]) => Promise<unknown>;
          };
        };
      }
    ).electron?.ipcRenderer?.invoke ?? null
  );
}

export async function readHintState(): Promise<HintState | null> {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    return (await invoke("tour:get-state")) as HintState;
  } catch {
    return null;
  }
}

export async function writeHintState(
  partial: Partial<HintState>,
): Promise<void> {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    await invoke("tour:set-state", partial);
  } catch {
    /* A hint that fails to record is a hint shown twice, not a broken app. */
  }
}

/** Mark a one-time hint as seen, preserving every other hint's record. */
export async function markHintSeen(id: HintId): Promise<void> {
  const state = await readHintState();
  await writeHintState({
    featureTours: {
      ...state?.featureTours,
      [id]: { completed: true, step: 0 },
    },
  });
}

export function hintWasSeen(state: HintState | null, id: HintId): boolean {
  return Boolean(state?.featureTours?.[id]?.completed);
}
