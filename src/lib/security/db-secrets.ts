import { encrypt, decrypt } from "@/main/settings";
import type { Secret } from "@/lib/schemas";

function isSecretJson(stored: string): boolean {
  try {
    const parsed = JSON.parse(stored) as Secret;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.value === "string" &&
      (parsed.encryptionType === "electron-safe-storage" ||
        parsed.encryptionType === "plaintext")
    );
  } catch {
    return false;
  }
}

/** Store plaintext API key as encrypted Secret JSON in SQLite. */
export function serializeApiKeyForDb(plain: string): string {
  return JSON.stringify(encrypt(plain.trim()));
}

/**
 * Read API key from DB column (encrypted Secret JSON or legacy plaintext).
 */
export function deserializeApiKeyFromDb(
  stored: string | null | undefined,
): string | undefined {
  if (!stored?.trim()) return undefined;

  if (isSecretJson(stored)) {
    try {
      return decrypt(JSON.parse(stored) as Secret);
    } catch {
      return undefined;
    }
  }

  // Legacy plaintext
  return stored;
}

/** True when value is legacy plaintext needing migration. */
export function isPlaintextApiKeyInDb(stored: string | null | undefined): boolean {
  if (!stored?.trim()) return false;
  return !isSecretJson(stored);
}
