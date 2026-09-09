import { describe, expect, it } from "vitest";
import {
  isMcpOAuthDeepLink,
  parseMcpOAuthCallbackUrl,
} from "@/lib/mcp/mcp-oauth-service";

describe("mcp-oauth-service deep link parsing", () => {
  it("detects MCP OAuth callback URLs", () => {
    expect(
      isMcpOAuthDeepLink("atlarix://mcp/oauth/callback?code=abc&state=xyz"),
    ).toBe(true);
    expect(isMcpOAuthDeepLink("atlarix://auth/callback")).toBe(false);
  });

  it("parses code and state from callback URL", () => {
    expect(
      parseMcpOAuthCallbackUrl(
        "atlarix://mcp/oauth/callback?code=abc123&state=state456",
      ),
    ).toEqual({ code: "abc123", state: "state456" });
  });
});
