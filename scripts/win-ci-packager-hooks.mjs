/**
 * Packager hook helpers for Windows CI.
 *
 * @electron/packager's serialHooks + util.promisify(async fn) passes only 4 args (no
 * callback), so serialHooks treats arch as done() and inner hooks never run reliably.
 * Match electron-forge package.ts: one callback-last hook that awaits async work.
 */

/**
 * @param {Array<(buildPath: string, electronVersion: string, platform: string, arch: string) => Promise<void>>} hooks
 * @returns {Array<(buildPath: string, electronVersion: string, platform: string, arch: string, done: (err?: Error) => void) => void>}
 */
export function sequentialPackagerHooks(hooks) {
  const runner = (buildPath, electronVersion, platform, arch, done) => {
    void (async () => {
      try {
        for (const hook of hooks) {
          await hook(buildPath, electronVersion, platform, arch);
        }
        done();
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  };
  return [runner];
}
