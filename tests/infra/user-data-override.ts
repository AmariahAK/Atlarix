/**
 * Mutable userData override consulted by the agent-evals setup file's partial
 * mock of `@/paths/paths`.
 *
 * Under vitest there is no `process.versions.electron`, so the real
 * `getUserDataPath()` falls back to `path.resolve("./userData")` (cwd-relative).
 * Agent evals need a per-file temp dir instead so the real sqlite DB and app
 * data land in an isolated, disposable location.
 */
let userDataDir: string | null = null;

export function setUserDataDir(dir: string | null): void {
  userDataDir = dir;
}

export function getUserDataDirOverride(): string | null {
  return userDataDir;
}
