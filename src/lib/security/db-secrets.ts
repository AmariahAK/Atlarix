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
export function isPlaintextApiKeyInDb(
  stored: string | null | undefined,
): boolean {
  if (!stored?.trim()) return false;
  return !isSecretJson(stored);
}

/**
 * Encrypt each value of an MCP env map as a Secret JSON blob before storing.
 * Keys (the env-var names) stay plaintext; values (often `GITHUB_TOKEN`,
 * `*_API_KEY`, …) are encrypted at rest, mirroring how `apiKey` is stored.
 */
export function encryptEnvForDb(
  env: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = serializeApiKeyForDb(v);
  return out;
}

/** Decrypt an MCP env map read from the DB (tolerates legacy plaintext values). */
export function decryptEnvFromDb(
  env: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = deserializeApiKeyFromDb(v) ?? "";
  }
  return out;
}
