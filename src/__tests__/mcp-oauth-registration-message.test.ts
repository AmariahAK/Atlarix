import { describe, expect, it } from "vitest";
import { describeMcpOAuthError, MCP_CONNECTOR_GUIDE_URL, needsPreRegisteredClient } from "@/lib/mcp/oauth-error-message";

/**
 * A server that refuses dynamic client registration: the SDK's error for it is
 * accurate and useless. Every surface shows the message this module returns,
 * and it says what to do next, never why (owner, 2026-11-07).
 */
describe("the registration error, as the person sees it", () => {
  const sdk = new Error("Incompatible auth server: does not support dynamic client registration");

  it("for Slack's server: use Atlarix in Slack, with the guide", () => {
    expect(needsPreRegisteredClient(sdk)).toBe(true);
    const text = describeMcpOAuthError(sdk, "https://mcp.slack.com/mcp");
    expect(text).toBe(`Use Atlarix in Slack instead: ${MCP_CONNECTOR_GUIDE_URL}`);
    expect(text).not.toContain("Incompatible auth server");
  });

  it("for any other server: the one thing the person can do, no registration talk", () => {
    const text = describeMcpOAuthError(sdk, "https://mcp.example.com/mcp");
    expect(text).toBe("Atlarix can't sign in to this server. If it offers an API key, add it with the key instead.");
    expect(text).not.toMatch(/regist|pre-registered|slack/i);
    // No URL known: the same plain line, not Slack's.
    expect(describeMcpOAuthError(sdk)).toBe(text);
  });

  it("a host that only looks like Slack's is not Slack's", () => {
    expect(describeMcpOAuthError(sdk, "https://slack.com.evil.example/mcp")).not.toContain("Slack");
    expect(describeMcpOAuthError(sdk, "not a url")).not.toContain("Slack");
  });

  it("recognises the proxy's own code for the same case", () => {
    expect(needsPreRegisteredClient(new Error("client_registration_required"))).toBe(true);
    expect(describeMcpOAuthError(new Error("client_registration_required"), "https://mcp.slack.com/mcp")).toContain(
      "Atlarix in Slack",
    );
  });

  it("leaves every other failure's words alone", () => {
    const other = new Error("invalid_grant: the code has expired");
    expect(needsPreRegisteredClient(other)).toBe(false);
    expect(describeMcpOAuthError(other, "https://mcp.slack.com/mcp")).toBe("invalid_grant: the code has expired");
    expect(describeMcpOAuthError("plain string")).toBe("plain string");
  });
});
