/**
 * Locate the bundled computer-use binaries, in dev and in a packaged app.
 *
 * WHICH PATTERN THIS FOLLOWS, AND WHY NOT THE OTHER ONE.
 *
 * There are two resolvers in this repo. `findLinuxHelper` / `findWindowsHelper` in
 * `src/lib/sandbox/wrap-command.ts` check an env override then
 * `process.resourcesPath` and stop — no dev branch at all, so under
 * `electron-forge start` they never resolve and the sandbox silently falls back.
 * For a security control that degrades safely, survivable. For a FEATURE it would
 * mean computer use simply never works in development and nobody notices until CI,
 * which is when a Rust bug is most expensive to diagnose.
 *
 * So this copies `resolveSnapshotPath()` in `src/lib/models_dev.ts` instead: env
 * override → packaged → dev → cwd fallback. That is also the resolver carrying the
 * scar tissue — its comment records the cwd fallback silently disabling the offline
 * model catalog in headless runs, because cwd there is the benchmark task dir.
 *
 * Two deliberate deviations from it:
 *   1. `existsSync` before returning, so "not installed" is distinguishable from
 *      "present but broken" — those get different messages to the model, and one
 *      of them is retryable.
 *   2. The fallback returns `null` on a miss rather than a hopeful path. The caller
 *      is about to spawn, and an ENOENT from a guessed path is a worse error
 *      message than "not installed".
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("computer-use");

export type ComputerBinary = "cua-driver" | "atlarix-cu";

/** Env overrides, for a dev who builds the binaries somewhere else. */
const ENV_OVERRIDE: Record<ComputerBinary, string> = {
  "cua-driver": "ATLARIX_CUA_DRIVER",
  "atlarix-cu": "ATLARIX_CU_HELPER",
};

/** Memoized per binary. Resolution shells nothing, but it does hit the disk. */
const cache = new Map<ComputerBinary, string | null>();

function exeSuffix(): string {
  return process.platform === "win32" ? ".exe" : "";
}

function resolveUncached(name: ComputerBinary): string | null {
  const override = process.env[ENV_OVERRIDE[name]];
  if (override && existsSync(override)) return override;

  const file = `${name}${exeSuffix()}`;
  try {
    if (app.isPackaged) {
      // `extraResource` copies by BASENAME into resources/ — see forge.config.ts.
      const p = path.join(process.resourcesPath, file);
      return existsSync(p) ? p : null;
    }
    // Dev: whatever `npm run build:cua-driver` / `build:cu-helper` staged.
    const p = path.join(app.getAppPath(), "native", ".dist", file);
    return existsSync(p) ? p : null;
  } catch {
    // Outside Electron (a unit test, or the headless CLI importing this module).
    const p = path.join(process.cwd(), "native", ".dist", file);
    return existsSync(p) ? p : null;
  }
}

export function resolveComputerBinary(name: ComputerBinary): string | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const resolved = resolveUncached(name);
  cache.set(name, resolved);
  // Logged at info, once, because a control that degrades silently is
  // unobservable — the same reason `wrapCommandInSandbox` logs its success rather
  // than only its failure.
  logger.info(`[computer-use] ${name}: ${resolved ?? "not found"}`);
  return resolved;
}

/** Tests only: forget what we resolved, so a fixture path can be swapped in. */
export function resetComputerBinaryCacheForTests(): void {
  cache.clear();
}

/**
 * The message a model gets when a binary is missing.
 *
 * Category 2 wording (one user action away, then retryable ONCE) for a build that
 * genuinely could have it, and a flat statement for one that cannot — the
 * distinction matters because an agent told "failed" retries, and retrying a
 * capability the build does not contain is an expensive way to learn nothing.
 */
export function missingBinaryMessage(name: ComputerBinary): string {
  if (name === "atlarix-cu" && process.platform === "linux") {
    return (
      "Local OCR is not available on Linux through Atlarix's own helper — that path uses " +
      "`tesseract`. If `tesseract` is not installed either, ask the user to install it " +
      "(`apt install tesseract-ocr` / `dnf install tesseract`). This is a platform " +
      "limitation, not a transient failure — do not retry."
    );
  }
  return (
    `The bundled \`${name}\` helper is not present in this build, so desktop control is ` +
    "unavailable. There is nothing to work around here — tell the user, and do not retry."
  );
}
