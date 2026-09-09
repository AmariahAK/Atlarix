/**
 * Runtime guard: are we executing in the Electron/Node *main* process
 * (or a plain Node script), as opposed to a renderer / browser bundle?
 *
 * Electron's renderer also exposes `process.versions.node`, so a bare
 * `process.versions.node` check is not enough — Vite externalizes any
 * `node:*` imports in the renderer bundle and they throw at runtime
 * ("Module 'node:crypto' has been externalized for browser compatibility").
 *
 * The `typeof window === "undefined"` clause is what makes this safe to
 * call from modules shared between the main and renderer processes.
 */
export function isMainProcessNode(): boolean {
  return (
    typeof window === "undefined" &&
    typeof process !== "undefined" &&
    Boolean(process.versions?.node)
  );
}
