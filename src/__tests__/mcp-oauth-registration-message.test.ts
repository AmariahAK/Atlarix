import { describe, expect, it } from "vitest";
import { describeMcpOAuthError, MCP_CONNECTOR_GUIDE_URL, needsPreRegisteredClient } from "@/lib/mcp/oauth-error-message";

/**
 * Slack's MCP server refuses dynamic client registration; the SDK's error for
 * that is accurate and useless. Every surface shows the message this module
 * returns, so the pointer to the guide is pinned here once.
 */
describe("the registration error, as the person sees it", () => {
  it("turns the SDK's 'does not support dynamic client registration' into the guide", () => {
    const sdk = new Error("Incompatible auth server: does not support dynamic client registration");
    expect(needsPreRegisteredClient(sdk)).toBe(true);
    const text = describeMcpOAuthError(sdk);
    expect(text).toContain("pre-registered app");
    expect(text).toContain(MCP_CONNECTOR_GUIDE_URL);
    expect(text).not.toContain("Incompatible auth server");
  });

  it("recognises the proxy's own code for the same case", () => {
    expect(needsPreRegisteredClient(new Error("client_registration_required"))).toBe(true);
  });

  it("leaves every other failure's words alone", () => {
    const other = new Error("invalid_grant: the code has expired");
    expect(needsPreRegisteredClient(other)).toBe(false);
    expect(describeMcpOAuthError(other)).toBe("invalid_grant: the code has expired");
    expect(describeMcpOAuthError("plain string")).toBe("plain string");
  });
});
