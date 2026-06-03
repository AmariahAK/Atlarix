import { describe, expect, it, vi } from "vitest";
import {
  hasOAuthCredentials,
  isOAuthTokenValid,
  oauthConnectedFromRow,
} from "@/lib/mcp/oauth-token-utils";

vi.mock("@/main/settings", () => ({
  encrypt: (value: string) => ({
    value,
    encryptionType: "plaintext",
  }),
  decrypt: (secret: { value: string }) => secret.value,
}));

describe("oauth-token-utils", () => {
  it("validates access token presence", () => {
    expect(isOAuthTokenValid(undefined)).toBe(false);
    expect(isOAuthTokenValid({ access_token: "", token_type: "bearer" })).toBe(
      false,
    );
    expect(
      isOAuthTokenValid({ access_token: "tok", token_type: "bearer" }),
    ).toBe(true);
  });

  it("hasOAuthCredentials detects refresh-only tokens", () => {
    expect(
      hasOAuthCredentials({
        access_token: "",
        refresh_token: "refresh",
        token_type: "bearer",
      }),
    ).toBe(true);
  });

  it("derives oauthConnected from row", () => {
    expect(
      oauthConnectedFromRow({ authType: "oauth", oauthTokensJson: null }),
    ).toBe(false);
    expect(
      oauthConnectedFromRow({
        authType: "env",
        oauthTokensJson: '{"value":"{\\"access_token\\":\\"x\\",\\"token_type\\":\\"bearer\\"}"}',
      }),
    ).toBe(false);
  });
});
