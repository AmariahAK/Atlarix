/** Renderer stub — shell env is resolved in the main process only. */
export function shellEnvSync(): Record<string, string> {
  return {};
}

export async function shellEnv(): Promise<Record<string, string>> {
  return {};
}
