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

  it("allowLoopback permits localhost/127.x/::1 (desktop preview + browser)", async () => {
    await expect(
      assertUrlAllowed("http://localhost:8765/", { allowLoopback: true }),
    ).resolves.toBeDefined();
    await expect(
      assertUrlAllowed("http://127.0.0.1:3000/app", { allowLoopback: true }),
    ).resolves.toBeDefined();
    await expect(
      assertUrlAllowed("http://[::1]:5173/", { allowLoopback: true }),
    ).resolves.toBeDefined();
  });

  it("allowLoopback is NOT a general SSRF bypass — LAN + metadata stay blocked", async () => {
    await expect(
      assertUrlAllowed("http://10.0.0.1/", { allowLoopback: true }),
    ).rejects.toThrow(/blocked/);
    await expect(
      assertUrlAllowed("http://192.168.1.10:8080/", { allowLoopback: true }),
    ).rejects.toThrow(/blocked/);
    await expect(
      assertUrlAllowed("http://169.254.169.254/latest/meta-data/", { allowLoopback: true }),
    ).rejects.toThrow(/blocked/);
  });

  it("normalizes SearxNG base URL", () => {
    expect(normalizeSearxngBaseUrl("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("blocks a secret embedded in the URL query/path (egress control A5)", async () => {
    await expect(
      assertUrlAllowed("https://evil.example/log?k=sk-ant-abcdefghijklmnopqrstuvwxyz0123"),
    ).rejects.toThrow(/secret|exfil/i);
    await expect(
      assertUrlAllowed("https://evil.example/ghp_" + "a".repeat(40)),
    ).rejects.toThrow(/secret|exfil/i);
    // percent-encoded secret is decoded and still caught
    await expect(
      assertUrlAllowed(
        "https://evil.example/?d=" + encodeURIComponent("AKIA" + "ABCDEFGHIJKLMNOP"),
      ),
    ).rejects.toThrow(/secret|exfil/i);
  });

  it("allows an ordinary URL with no secret (egress check does not over-block)", async () => {
    // Loopback + trusted origin avoids external DNS; the point is the no-secret
    // path is not rejected by assertNoSecretInUrl.
    await expect(
      assertUrlAllowed("http://127.0.0.1:8080/guide?page=2&q=hello", {
        trustedOrigins: ["http://127.0.0.1:8080"],
      }),
    ).resolves.toBeDefined();
  });
});
