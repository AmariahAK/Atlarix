/**
 * D1 — conservative secret redaction. Masks high-confidence credential shapes;
 * leaves ordinary text/IDs/hashes untouched (no over-redaction).
 */
import { describe, expect, it } from "vitest";
import {
  redactSecretsInText,
  containsSecret,
} from "@/lib/security/redact-secrets";
import { redactedToolTextForModel } from "@/lib/ai/tool-model-output";

describe("redactSecretsInText", () => {
  const SECRETS = [
    "sk-abcdefghijklmnopqrstuvwx1234567890",
    "sk-ant-api03-AbCdEf1234567890AbCdEf1234567890",
    "sk-proj-AbCdEf1234567890AbCdEf1234567890",
    "ghp_0123456789abcdef0123456789abcdef0123",
    "github_pat_11ABCDEFG0123456789_abcdefABCDEF",
    "AKIAIOSFODNN7EXAMPLE",
    `AIza${"b".repeat(35)}`, // Google API key = "AIza" + exactly 35 chars
    "xoxb-12345678901-abcdefABCDEF",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  ];

  for (const secret of SECRETS) {
    it(`masks: ${secret.slice(0, 10)}…`, () => {
      const out = redactSecretsInText(`key=${secret} done`);
      expect(out).toContain("[redacted secret]");
      expect(out).not.toContain(secret);
      expect(out).toContain("done");
      expect(containsSecret(secret)).toBe(true);
    });
  }

  it("masks PEM private-key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactSecretsInText(pem)).toBe("[redacted secret]");
  });

  it("PRESERVES ordinary text, IDs, hashes, and prose", () => {
    const samples = [
      "The build finished in 42s with 0 errors.",
      "commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", // git sha
      "user_id: 7f3e9c1a-2b4d-4e6f-8a0b-1c2d3e4f5a6b", // uuid
      "Set VITE_SUPABASE_URL in your .env file",
      "function readFile() { return 1; }",
    ];
    for (const s of samples) {
      expect(redactSecretsInText(s)).toBe(s);
      expect(containsSecret(s)).toBe(false);
    }
  });

  it("is idempotent and handles empty input", () => {
    const once = redactSecretsInText("token ghp_0123456789abcdef0123456789abcdef0123");
    expect(redactSecretsInText(once)).toBe(once);
    expect(redactSecretsInText("")).toBe("");
  });
});

// WS7: the OUTBOUND path — what the model receives, not just the UI copy.
describe("redactedToolTextForModel (outbound tool result)", () => {
  it("masks a secret in a raw string tool result", () => {
    const out = redactedToolTextForModel(
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx1234567890",
    );
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwx1234567890");
    expect(out).toContain("[redacted secret]");
  });

  it("masks a secret inside a stringified object tool result (stdout/stderr)", () => {
    const out = redactedToolTextForModel({
      success: true,
      stdout: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nGITHUB_TOKEN=ghp_0123456789abcdef0123456789abcdef0123",
    });
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("ghp_0123456789abcdef0123456789abcdef0123");
  });

  it("leaves ordinary tool output untouched", () => {
    const out = redactedToolTextForModel({ success: true, stdout: "Build ok in 3s" });
    expect(out).toContain("Build ok in 3s");
  });
});
