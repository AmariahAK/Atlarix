import http from "node:http";
import { describe, expect, it } from "vitest";
import { AtlarixOAuthProvider } from "@/lib/mcp/atlarix-oauth-provider";
import { createMcpOAuthLoopbackServer } from "@/lib/mcp/oauth-loopback-server";
import { shouldClearStaleOAuthClient } from "@/lib/mcp/oauth-token-utils";

describe("shouldClearStaleOAuthClient", () => {
  it("returns false when no cached client exists", () => {
    expect(
      shouldClearStaleOAuthClient(undefined, "http://127.0.0.1:1234/callback"),
    ).toBe(false);
  });

  it("returns true when redirect_uris do not include current loopback URL", () => {
    expect(
      shouldClearStaleOAuthClient(
        {
          client_id: "abc",
          redirect_uris: ["http://127.0.0.1:9999/callback"],
        },
        "http://127.0.0.1:1234/callback",
      ),
    ).toBe(true);
  });

  it("returns false when redirect_uris match current loopback URL", () => {
    expect(
      shouldClearStaleOAuthClient(
        {
          client_id: "abc",
          redirect_uris: ["http://127.0.0.1:1234/callback"],
        },
        "http://127.0.0.1:1234/callback",
      ),
    ).toBe(false);
  });

  it("returns true when cached client has no redirect_uris", () => {
    expect(
      shouldClearStaleOAuthClient({ client_id: "abc" }, "http://127.0.0.1:1/callback"),
    ).toBe(true);
  });
});

describe("AtlarixOAuthProvider redirect URL", () => {
  it("uses the redirect URL passed to the constructor", () => {
    const provider = new AtlarixOAuthProvider(
      1,
      "Test MCP",
      "http://127.0.0.1:54321/callback",
    );
    expect(provider.redirectUrl).toBe("http://127.0.0.1:54321/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual([
      "http://127.0.0.1:54321/callback",
    ]);
  });
});

describe("createMcpOAuthLoopbackServer", () => {
  it("binds loopback and receives OAuth callback query params", async () => {
    const loopback = await createMcpOAuthLoopbackServer();
    expect(loopback.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const callbackPromise = loopback.waitForCallback();
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          `${loopback.redirectUrl}?code=test-code&state=test-state`,
          (res) => {
            res.resume();
            resolve();
          },
        )
        .on("error", reject);
    });

    await expect(callbackPromise).resolves.toEqual({
      code: "test-code",
      state: "test-state",
      error: undefined,
      errorDescription: undefined,
    });
    loopback.close();
  });
});
