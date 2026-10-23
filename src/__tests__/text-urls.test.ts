/**
 * URLs in plain text (CLI links, ACP resource_link): QA E2. A balanced "(…)"
 * belongs to the URL; a ")" that closes the prose around it, and trailing
 * punctuation, do not.
 */
import { describe, expect, it } from "vitest";
import { urlsIn } from "@/lib/text/urls";

describe("urlsIn", () => {
  it("keeps a balanced parenthesis inside the URL", () => {
    expect(urlsIn("Wiki https://en.wikipedia.org/wiki/Rust_(programming_language)")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
    ]);
    expect(urlsIn("https://example.com/a_(b)_c?x=(1)")).toEqual(["https://example.com/a_(b)_c?x=(1)"]);
  });

  it("drops the prose's closing parenthesis and trailing punctuation", () => {
    expect(urlsIn("(https://github.com/acme/app/pull/7), done")).toEqual(["https://github.com/acme/app/pull/7"]);
    expect(urlsIn("a (https://x.dev/y_(z)) b")).toEqual(["https://x.dev/y_(z)"]);
    expect(urlsIn("see https://example.com/docs.")).toEqual(["https://example.com/docs"]);
  });

  it("only http(s), each once", () => {
    expect(urlsIn("javascript:alert(1) file:///x http://a.dev http://a.dev")).toEqual(["http://a.dev"]);
  });
});
