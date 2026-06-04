import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  hasOAuthCredentials,
  isOAuthTokenValid,
  resolveOAuthRedirectUrlFromRow,
} from "@/lib/mcp/oauth-token-utils";
import { normalizeSkillWorkspacePath } from "@/paths/paths";

describe("oauth token persistence", () => {
  it("hasOAuthCredentials accepts access_token or refresh_token", () => {
    expect(hasOAuthCredentials(undefined)).toBe(false);
    expect(
      hasOAuthCredentials({ access_token: "a", token_type: "bearer" }),
    ).toBe(true);
    expect(
      hasOAuthCredentials({ access_token: "", refresh_token: "r", token_type: "bearer" }),
    ).toBe(true);
  });

  it("isOAuthTokenValid uses wall-clock expiry when obtained_at is set", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      isOAuthTokenValid({
        access_token: "a",
        token_type: "bearer",
        expires_in: 3600,
        obtained_at: now - 7200,
      }),
    ).toBe(false);
    expect(
      isOAuthTokenValid({
        access_token: "a",
        token_type: "bearer",
        expires_in: 3600,
        obtained_at: now - 100,
      }),
    ).toBe(true);
  });

  it("isOAuthTokenValid stays valid with refresh_token even when access expired", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      isOAuthTokenValid({
        access_token: "a",
        refresh_token: "r",
        token_type: "bearer",
        expires_in: 60,
        obtained_at: now - 3600,
      }),
    ).toBe(true);
  });

  it("resolveOAuthRedirectUrlFromRow prefers stored client redirect", () => {
    expect(
      resolveOAuthRedirectUrlFromRow({
        oauthClientJson: null,
        fallbackRedirectUrl: "http://127.0.0.1/callback",
      }),
    ).toBe("http://127.0.0.1/callback");
  });
});

describe("normalizeSkillWorkspacePath", () => {
  it("resolves relative workspace paths to absolute", () => {
    const normalized = normalizeSkillWorkspacePath("my-app");
    expect(normalized).toMatch(/my-app$/);
    // Windows absolute paths start with a drive letter, not "/".
    expect(path.isAbsolute(normalized)).toBe(true);
  });
});
