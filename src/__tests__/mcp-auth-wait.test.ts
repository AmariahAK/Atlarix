import { describe, expect, it } from "vitest";
import {
  waitForMcpAuth,
  notifyMcpAuthUpdated,
  cancelMcpOAuthFlow,
} from "@/lib/mcp/mcp-oauth-service";

describe("waitForMcpAuth", () => {
  it("resolves true when the server's credentials are saved", async () => {
    const p = waitForMcpAuth(4242);
    notifyMcpAuthUpdated(4242);
    expect(await p).toBe(true);
  });

  it("resolves false when the OAuth flow is cancelled", async () => {
    const p = waitForMcpAuth(4244);
    cancelMcpOAuthFlow(4244);
    expect(await p).toBe(false);
  });

  it("blocks INDEFINITELY — never self-resolves without auth/abort (B3 contract)", async () => {
    const wait = waitForMcpAuth(4243).then(() => "resolved" as const);
    const race = await Promise.race([
      wait,
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(race).toBe("pending");
    // settle it so the pending promise doesn't leak into other tests
    cancelMcpOAuthFlow(4243);
    expect(await wait).toBe("resolved");
  });

  it("resolves false when the turn's abort signal fires (Stop)", async () => {
    const ac = new AbortController();
    const p = waitForMcpAuth(4247, { abortSignal: ac.signal });
    ac.abort();
    expect(await p).toBe(false);
  });

  it("resolves false immediately if the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await waitForMcpAuth(4248, { abortSignal: ac.signal })).toBe(false);
  });

  it("only settles the matching server's waiter", async () => {
    const ac = new AbortController();
    const a = waitForMcpAuth(4245);
    const b = waitForMcpAuth(4246, { abortSignal: ac.signal });
    notifyMcpAuthUpdated(4245);
    expect(await a).toBe(true);
    ac.abort();
    expect(await b).toBe(false); // 4246 unaffected by 4245's success
  });
});
