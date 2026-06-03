import { describe, expect, it } from "vitest";
import {
  assertUrlAllowed,
  normalizeSearxngBaseUrl,
} from "@/lib/security/url-policy";

describe("url-policy", () => {
  it("blocks non-http(s) schemes", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toThrow(/only http/);
  });

  it("blocks private IPv4 without trusted origin", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1/")).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed("http://10.0.0.1/")).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed("http://192.168.1.1/")).rejects.toThrow(/blocked/);
    await expect(assertUrlAllowed("http://169.254.169.254/")).rejects.toThrow(/blocked/);
  });

  it("allows loopback when trusted origin matches", async () => {
    const url = "http://127.0.0.1:8080/search";
    await expect(
      assertUrlAllowed(url, {
        trustedOrigins: ["http://127.0.0.1:8080"],
      }),
    ).resolves.toBeDefined();
  });

  it("normalizes SearxNG base URL", () => {
    expect(normalizeSearxngBaseUrl("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
  });
});
