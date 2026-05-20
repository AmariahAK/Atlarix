import type { SupportedStorage } from "@supabase/supabase-js";

/** Renderer stub — session storage uses main-process keychain via IPC. */
export function createSecureSupabaseStorage(): SupportedStorage {
  return {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  };
}

export async function clearSupabaseSecureStorage(): Promise<void> {}
