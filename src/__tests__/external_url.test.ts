import { describe, it, expect } from "vitest";
import { validateOpenExternalUrl } from "../lib/external_url";

describe("validateOpenExternalUrl", () => {
  it("accepts https URLs", () => {
    expect(() => validateOpenExternalUrl("https://atlarix.dev")).not.toThrow();
  });

  it("accepts http URLs", () => {
    expect(() =>
      validateOpenExternalUrl("http://example.com/path"),
    ).not.toThrow();
  });

  it("accepts mailto URLs with query params", () => {
    expect(() =>
      validateOpenExternalUrl(
        "mailto:support@atlarix.dev?subject=test&body=hello",
      ),
    ).not.toThrow();
  });

  it("rejects javascript URLs", () => {
    expect(() => validateOpenExternalUrl("javascript:alert(1)")).toThrow(
      /invalid or non-http/,
    );
  });

  it("rejects file URLs", () => {
    expect(() => validateOpenExternalUrl("file:///C:/Users")).toThrow(
      /invalid or non-http/,
    );
  });

  it("rejects empty URL", () => {
    expect(() => validateOpenExternalUrl("")).toThrow(/No URL provided/);
  });

  it("rejects mailto with newlines", () => {
    expect(() =>
      validateOpenExternalUrl("mailto:a@b.com\nBcc:evil@x.com"),
    ).toThrow(/Invalid mailto/);
  });
});
