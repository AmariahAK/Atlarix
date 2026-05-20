/**
 * Renderer stub — SQLite lives in the main process only.
 */
export const db = new Proxy(
  {},
  {
    get() {
      throw new Error("Database access is only available in the main process");
    },
  },
);

export async function initializeDatabase(): Promise<void> {}

export function getDatabasePath(): string {
  return "";
}
