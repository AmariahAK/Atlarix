/**
 * One CLI value parser for the build/verify scripts, because having several was a
 * silent-wrong-output bug.
 *
 * THE FAILURE THIS EXISTS TO PREVENT, observed in CI on 2026-09-05:
 * Build scripts once parsed only the space-separated
 * form (`indexOf("--arch")` then `argv[i + 1]`), while the workflow invokes them as
 * `npm run <script> -- --arch=x64`. `indexOf` found nothing, the scripts
 * fell back to `process.arch`, and on an arm64 `macos-latest` runner the x64 job
 * built `aarch64-apple-darwin` while printing `--arch=x64` in the very same log
 * line. Every internal check still passed, because each one compared the binary
 * against the RESOLVED target rather than the REQUESTED one — they agreed with each
 * other and were both wrong. Only `verify-ci-package-out.mjs`, which re-reads the
 * arch off the copy inside the package, caught it.
 *
 * Without that assertion the Intel DMG would have shipped arm64 helpers: the app
 * installs, launches, and computer use is simply dead on every Intel Mac.
 *
 * So: accept BOTH forms everywhere, and never hand-roll this again. `--name=value`
 * wins over a following bare token so `--arch=x64 --target foo` cannot mis-pair.
 */

/**
 * Read `--name value` or `--name=value` from an argv array.
 * @param {string[]} argv Full argv (scanned from index 2, like node's).
 * @param {string} name Flag name without dashes.
 * @returns {string | undefined}
 */
export function argValue(argv, name) {
  const eq = `--${name}=`;
  const bare = `--${name}`;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(eq)) return a.slice(eq.length);
    // A bare flag with no following token is not a value — returning `undefined`
    // lets the caller's `??` default fire rather than swallowing the next flag.
    if (a === bare) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("--") ? next : undefined;
    }
  }
  return undefined;
}

/**
 * Presence of a boolean flag, in either `--name` or `--name=true` form.
 * @param {string[]} argv
 * @param {string} name
 * @returns {boolean}
 */
export function argFlag(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}` || a.startsWith(`--${name}=`)) return true;
  }
  return false;
}
