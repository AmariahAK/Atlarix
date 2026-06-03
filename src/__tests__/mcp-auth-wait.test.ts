import { describe, expect, it } from "vitest";
import {
  waitForMcpAuth,
  notifyMcpAuthUpdated,
  cancelMcpOAuthFlow,
} from "@/lib/mcp/mcp-oauth-service";

describe("waitForMcpAuth", () => {
  it("resolves true when the server's credentials are saved", async () => {
    const p = waitForMcpAuth(4242, 5_000);
    notifyMcpAuthUpdated(4242);
    expect(await p).toBe(true);
  });

  it("resolves false on timeout", async () => {
    expect(await waitForMcpAuth(4243, 15)).toBe(false);
  });

  it("resolves false when the OAuth flow is cancelled", async () => {
    const p = waitForMcpAuth(4244, 5_000);
    cancelMcpOAuthFlow(4244);
    expect(await p).toBe(false);
  });

  it("only settles the matching server's waiter", async () => {
    const a = waitForMcpAuth(4245, 5_000);
    const b = waitForMcpAuth(4246, 30);
    notifyMcpAuthUpdated(4245);
    expect(await a).toBe(true);
    expect(await b).toBe(false); // 4246 times out, unaffected by 4245
  });
});
