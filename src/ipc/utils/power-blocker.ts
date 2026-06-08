/**
 * Keeps the app's CPU alive while an AI stream is in flight so long-running
 * tasks keep progressing when the display goes to sleep.
 *
 * macOS note: `prevent-app-suspension` stops App Nap / display-sleep from
 * pausing us, but it CANNOT prevent suspend when the laptop lid is closed —
 * that is OS-enforced. This matches the intended behaviour: keep working when
 * the *screen* sleeps, not when the lid is shut.
 *
 * Reference-counted: the first active stream starts the blocker, the last one
 * to finish stops it. All start/stop goes through here so we never leak a
 * blocker or hold one with no active work.
 */
import { powerSaveBlocker } from "electron";
import log from "electron-log";

const logger = log.scope("power-blocker");

let blockerId: number | null = null;
let refCount = 0;

/** Acquire the power-save blocker (idempotent past the first active stream). */
export function acquirePowerSaveBlocker(): void {
  refCount += 1;
  if (refCount === 1 && (blockerId === null || !powerSaveBlocker.isStarted(blockerId))) {
    try {
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
      logger.log(`Started power-save blocker (id=${blockerId}) — task active`);
    } catch (error) {
      logger.warn("Failed to start power-save blocker:", error);
      blockerId = null;
    }
  }
}

/** Release one reference; stops the blocker when no streams remain active. */
export function releasePowerSaveBlocker(): void {
  if (refCount === 0) return;
  refCount -= 1;
  if (refCount === 0) {
    stopBlocker();
  }
}

/** Force-stop the blocker and reset the count (used on bulk abort / quit). */
export function resetPowerSaveBlocker(): void {
  refCount = 0;
  stopBlocker();
}

function stopBlocker(): void {
  if (blockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
        logger.log(`Stopped power-save blocker (id=${blockerId}) — no active tasks`);
      }
    } catch (error) {
      logger.warn("Failed to stop power-save blocker:", error);
    }
    blockerId = null;
  }
}
