/**
 * At every database start: secrets stored readable are encrypted.
 *
 * Two kinds:
 * - legacy values that are not Secret JSON at all (always wrapped, as the
 *   original api_key migration did);
 * - Secret JSON marked `"encryptionType": "plaintext"`, which encrypt() writes
 *   when there is no OS key. Older CLIs and editors on Windows without the
 *   desktop app wrote these (11-06), for provider keys, MCP API keys, env and
 *   header values, and MCP OAuth tokens and client registrations. They are
 *   rewritten only once the key exists; with none there is nothing to encrypt
 *   with, and they stay.
 *
 * `oauth_discovery_json` is public metadata and is left alone.
 */
import type Database from "better-sqlite3";
import { serializeApiKeyForDb } from "@/lib/security/db-secrets";
import { isSecretEncryptionAvailable } from "@/main/settings";

/** One stored value: its replacement, or null when it is already fine. */
function upgrade(stored: unknown, keyed: boolean): string | null {
  if (typeof stored !== "string" || !stored.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
  }
  const sec = parsed as { value?: unknown; encryptionType?: unknown } | undefined;
  const isSecret =
    !!sec &&
    typeof sec === "object" &&
    typeof sec.value === "string" &&
    (sec.encryptionType === "electron-safe-storage" || sec.encryptionType === "plaintext");
  if (!isSecret) return serializeApiKeyForDb(stored);
  if (sec.encryptionType === "plaintext") return keyed ? serializeApiKeyForDb(sec.value as string) : null;
  return null;
}

/** A JSON map of stored values (env_json, headers_json). */
function upgradeMap(stored: unknown, keyed: boolean): { next: string; changed: number } | null {
  if (typeof stored !== "string" || !stored.trim()) return null;
  let map: unknown;
  try {
    map = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  let changed = 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    const u = upgrade(v, keyed);
    if (u != null) changed += 1;
    out[k] = u ?? v;
  }
  return changed ? { next: JSON.stringify(out), changed } : null;
}

function columns(sqlite: Database.Database, table: string): Set<string> {
  try {
    return new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  } catch {
    return new Set();
  }
}

/** @returns how many values were rewritten. */
export function migratePlaintextDbSecrets(sqlite: Database.Database): number {
  const keyed = isSecretEncryptionAvailable();
  let done = 0;
  const plan: Array<{ table: string; single: string[]; maps: string[] }> = [
    { table: "provider_api_keys", single: ["api_key"], maps: [] },
    { table: "mcp_servers", single: ["api_key", "oauth_tokens_json", "oauth_client_json"], maps: ["env_json", "headers_json"] },
  ];
  for (const { table, single, maps } of plan) {
    const have = columns(sqlite, table);
    const cols = [...single, ...maps].filter((c) => have.has(c));
    if (!cols.length || !have.has("id")) continue;
    const rows = sqlite.prepare(`SELECT id, ${cols.join(", ")} FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const set: Record<string, string> = {};
      for (const c of single.filter((x) => have.has(x))) {
        const u = upgrade(row[c], keyed);
        if (u != null) {
          set[c] = u;
          done += 1;
        }
      }
      for (const c of maps.filter((x) => have.has(x))) {
        const u = upgradeMap(row[c], keyed);
        if (u) {
          set[c] = u.next;
          done += u.changed;
        }
      }
      const names = Object.keys(set);
      if (!names.length) continue;
      sqlite
        .prepare(`UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`)
        .run(...names.map((n) => set[n]), row.id);
    }
  }
  return done;
}
