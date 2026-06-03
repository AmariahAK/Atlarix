import { describe, expect, it, beforeEach } from "vitest";
import {
  deserializeApiKeyFromDb,
  isPlaintextApiKeyInDb,
  serializeApiKeyForDb,
} from "@/lib/security/db-secrets";
import { __injectSafeStorageForTests } from "@/main/settings";

describe("db-secrets", () => {
  beforeEach(() => {
    __injectSafeStorageForTests(null);
  });

  it("round-trips through serialize/deserialize", () => {
    const stored = serializeApiKeyForDb("sk-test-secret-key");
    expect(isPlaintextApiKeyInDb(stored)).toBe(false);
    expect(deserializeApiKeyFromDb(stored)).toBe("sk-test-secret-key");
  });

  it("reads legacy plaintext", () => {
    expect(deserializeApiKeyFromDb("sk-legacy-plain")).toBe("sk-legacy-plain");
    expect(isPlaintextApiKeyInDb("sk-legacy-plain")).toBe(true);
  });
});
