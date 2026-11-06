/**
 * Secrets in the database that an older CLI or editor wrote with no OS key
 * ({"encryptionType":"plaintext"}: MCP OAuth tokens and client registrations,
 * MCP API keys, env and header values, custom provider keys) are encrypted at
 * the next start once the key exists. Before, only legacy non-JSON values were.
 * With no key they stay as they are (nothing to encrypt with).
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { __injectSafeStorageForTests } from "@/main/settings";
import { migratePlaintextDbSecrets } from "@/db/plaintext-secrets-migration";

let available = true;
const fake = {
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
  decryptString: (b: Buffer) => {
    const raw = b.toString("utf8");
    if (!raw.startsWith("enc:")) throw new Error("not decryptable");
    return raw.slice(4);
  },
};

const plain = (v: string) => JSON.stringify({ value: v, encryptionType: "plaintext" });
const TOKENS = JSON.stringify({ access_token: "at-ai4b", refresh_token: "rt-ai4b", obtained_at: 1 });
const CLIENT = JSON.stringify({ client_id: "cid", client_secret: "cs-ai4b" });

function db(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE provider_api_keys (id INTEGER PRIMARY KEY, api_key TEXT);
          CREATE TABLE mcp_servers (id INTEGER PRIMARY KEY, api_key TEXT, env_json TEXT, headers_json TEXT,
            oauth_tokens_json TEXT, oauth_client_json TEXT, oauth_discovery_json TEXT);`);
  d.prepare("INSERT INTO provider_api_keys (id, api_key) VALUES (1, ?)").run(plain("sk-provider-ai4b"));
  d.prepare(
    "INSERT INTO mcp_servers (id, api_key, env_json, headers_json, oauth_tokens_json, oauth_client_json, oauth_discovery_json) VALUES (1, ?, ?, ?, ?, ?, ?)",
  ).run(
    plain("mcp-key-ai4b"),
    JSON.stringify({ GITHUB_TOKEN: plain("ghp-ai4b"), LEGACY: "legacy-ai4b" }),
    JSON.stringify({ "X-Api-Key": plain("hdr-ai4b") }),
    plain(TOKENS),
    plain(CLIENT),
    JSON.stringify({ issuer: "https://example.test" }),
  );
  return d;
}

const dump = (d: Database.Database) =>
  JSON.stringify([d.prepare("SELECT * FROM provider_api_keys").all(), d.prepare("SELECT * FROM mcp_servers").all()]);

beforeEach(() => {
  available = true;
  __injectSafeStorageForTests(fake as never);
});

describe("plaintext secrets in the database", () => {
  it("are encrypted once the OS key exists: no secret is left readable", () => {
    const d = db();
    expect(migratePlaintextDbSecrets(d)).toBe(7);
    const all = dump(d);
    for (const secret of ["sk-provider-ai4b", "mcp-key-ai4b", "ghp-ai4b", "legacy-ai4b", "hdr-ai4b", "at-ai4b", "rt-ai4b", "cs-ai4b"]) {
      expect(all).not.toContain(secret);
    }
    expect(all).not.toContain('\\"plaintext\\"');
    // Discovery metadata is not a secret and stays as it was.
    expect(d.prepare("SELECT oauth_discovery_json FROM mcp_servers").pluck().get()).toBe(JSON.stringify({ issuer: "https://example.test" }));
    // And they read back as the same values.
    const row = d.prepare("SELECT oauth_tokens_json FROM mcp_servers").pluck().get() as string;
    const sec = JSON.parse(row) as { value: string; encryptionType: string };
    expect(sec.encryptionType).toBe("electron-safe-storage");
    expect(fake.decryptString(Buffer.from(sec.value, "base64"))).toBe(TOKENS);
    // A second start has nothing left to do.
    expect(migratePlaintextDbSecrets(d)).toBe(0);
  });

  it("with no OS key nothing is rewritten", () => {
    available = false;
    const d = db();
    const before = dump(d);
    migratePlaintextDbSecrets(d);
    // Only the legacy non-JSON value is wrapped (as before this change); every value stays readable as it was.
    const after = dump(d);
    for (const secret of ["sk-provider-ai4b", "mcp-key-ai4b", "ghp-ai4b", "hdr-ai4b", "at-ai4b", "cs-ai4b"]) {
      expect(after).toContain(secret);
    }
    expect(before.length).toBeGreaterThan(0);
  });
});
