/**
 * Resolve the ripgrep binary path used by the `grep` and `glob` tools.
 *
 * Prefers the BUNDLED `@vscode/ripgrep` binary so the app is self-contained and
 * doesn't depend on the user having `rg` on their PATH. In the packaged app the
 * binary is unpacked from the asar (see forge `asar.unpack`), so the raw
 * `rgPath` (which points inside app.asar) is remapped to app.asar.unpacked.
 *
 * Falls back to a bare `rg` on PATH when the bundled binary can't be resolved
 * (dev without an install, or a broken bundle) — so this is never worse than the
 * previous behavior of shelling out to `rg` directly.
 */

import * as fs from "node:fs";

let cached: string | null = null;

export async function resolveRipgrepPath(): Promise<string> {
  if (cached) return cached;
  try {
    const mod = (await import("@vscode/ripgrep")) as {
      rgPath?: string;
      default?: { rgPath?: string };
    };
    const rgPath = mod?.rgPath ?? mod?.default?.rgPath;
    if (rgPath) {
      const unpacked = rgPath.replace(
        /([\\/])app\.asar([\\/])/,
        "$1app.asar.unpacked$2",
      );
      if (fs.existsSync(unpacked)) return (cached = unpacked);
      if (fs.existsSync(rgPath)) return (cached = rgPath);
    }
  } catch {
    /* @vscode/ripgrep not resolvable — fall back to PATH `rg` */
  }
  return (cached = "rg");
}
