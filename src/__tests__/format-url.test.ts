import { describe, expect, it } from "vitest";
import { truncateUrl } from "@/lib/format-url";

describe("truncateUrl", () => {
  it("returns short urls unchanged", () => {
    expect(truncateUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("shortens long urls with host and last segment", () => {
    const long =
      "https://api.example.com/v1/organizations/acme/projects/default/mcp/sse?token=abcdef";
    const out = truncateUrl(long, 48);
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out).toContain("api.example.com");
    expect(out).toContain("…");
  });

  it("handles invalid urls with ellipsis", () => {
    const invalid = "not-a-url-but-still-a-very-long-string-that-should-shrink";
    const out = truncateUrl(invalid, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toContain("…");
  });
});
