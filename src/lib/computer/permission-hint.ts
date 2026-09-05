/**
 * Turn a missing macOS grant into a message the model can ACT on.
 *
 * # The failure this exists to stop
 *
 * Observed on a packaged build, 2026-09-05, driving WhatsApp with Screen Recording
 * ungranted. What the model was told, verbatim:
 *
 *     cannot read /var/folders/…/atlarix-ocr-GobYxw/window.png:
 *     No such file or directory (os error 2)
 *
 * That is the OCR helper reporting a missing input file. It is TRUE and it is
 * useless: nothing in it says a permission is missing, so the model cannot ask the
 * user for the one thing that would fix it. It tried the read again, then a second
 * app, then `screencapture` through the shell, and finally walked into the terminal
 * refusal — four wasted turns spent working around a dialog nobody was ever asked
 * to click.
 *
 * The preflight in `src/main/computer-use-permissions.ts` knew the answer the whole
 * time. It just was not on this path: it backed the settings panel and the doctor
 * row, and nothing consulted it when an OPERATION failed. A permission check that
 * only runs where things are already going well is not a permission check.
 *
 * # Why the driver call does not simply throw
 *
 * `get_window_state` SUCCEEDS with Screen Recording denied. It returns real
 * `window_bounds` and a real `screenshot_scale` from the window server — which need
 * no grant — and silently writes no image. So there is no exception to map; the
 * only evidence is a file that is not there. Callers must check for the artefact,
 * not for a thrown error, and that is the trap worth remembering here.
 *
 * # Wording
 *
 * Category 2 of the four in DESIGN_NOTES — one user action away, retryable ONCE.
 * The tail is asserted by test, because an agent told "do not retry" stops and one
 * told "failed" retries forever; a grant is neither.
 */
import log from "electron-log";
// STATIC, not a lazy `require`. An earlier draft used
// `require("@/main/computer-use-permissions")` to avoid pulling electron into
// callers' tests; the alias does not resolve through CJS require at runtime, so it
// threw, hit the catch below, returned null — and the hint would NEVER have fired
// in the packaged app. A test caught it; nothing else would have, because the
// failure mode is silence.
import { readPermissions } from "@/main/computer-use-permissions";

const logger = log.scope("computer-use");

/** The tail every category-2 message ends with. Asserted, not decorative. */
export const RETRY_AFTER_GRANT =
  "Ask the user to do that and retry ONCE after they confirm — do not retry before then.";

export type Grant = "accessibility" | "screen";

/**
 * A ready-to-return message when `need` is not granted, or `null` when it is.
 *
 * Reads the live state every call — never cached. A grant can be given while the
 * app runs, and a stale "denied" would keep refusing after the user has already
 * fixed it, which reads exactly like the feature being broken.
 */
export function missingGrantMessage(need: Grant): string | null {
  let perms: ReturnType<typeof readPermissions>;
  try {
    perms = readPermissions();
  } catch (e) {
    // Never let a diagnostic aid become the reason an action fails.
    logger.warn("[computer-use] could not read permission state:", e);
    return null;
  }

  // Only macOS gates these. On Windows and Linux "unsupported" means there is no
  // OS permission to ask for — claiming otherwise would send the user hunting
  // through a settings pane that has no such entry.
  if (perms.platform !== "darwin") return null;

  if (need === "accessibility" && perms.accessibility !== "granted") {
    return (
      "Atlarix does not have macOS Accessibility permission, so it cannot read or " +
      "click other applications. Grant it in System Settings › Privacy & Security › " +
      `Accessibility (Settings → Computer use has a button for this). ${RETRY_AFTER_GRANT}`
    );
  }

  if (need === "screen" && perms.screenRecording !== "granted") {
    return (
      "Atlarix does not have macOS Screen Recording permission, so it cannot capture " +
      "a window to read it. Grant it in System Settings › Privacy & Security › Screen " +
      "Recording, then RESTART Atlarix — macOS caches this decision per process, so a " +
      "grant does not take effect until the app restarts (Settings → Computer use has " +
      `a Restart button). Reading and clicking via mode:"tree" work without it. ${RETRY_AFTER_GRANT}`
    );
  }

  return null;
}
