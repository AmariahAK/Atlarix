import { describe, expect, it } from "vitest";
import {
  LOCALHOST_URL_RE,
  isBareLocalhostUrl,
} from "@/lib/browser/localhost-url";

describe("localhost URL linkification", () => {
  it("treats a bare localhost:PORT (and variants) as a link target", () => {
    expect(isBareLocalhostUrl("localhost:3000")).toBe(true);
    expect(isBareLocalhostUrl("127.0.0.1:8080/login")).toBe(true);
    expect(isBareLocalhostUrl("0.0.0.0:5173")).toBe(true);
    expect(isBareLocalhostUrl("[::1]:3000")).toBe(true);
  });

  it("does NOT linkify bare 'localhost' without a port, or external hosts", () => {
    expect(isBareLocalhostUrl("localhost")).toBe(false);
    expect(isBareLocalhostUrl("example.com:3000")).toBe(false);
    expect(isBareLocalhostUrl("http://localhost:3000")).toBe(false); // scheme → remark-gfm autolinks
  });

  it("finds localhost URLs embedded in prose (global matcher)", () => {
    const raw =
      "Your app is at localhost:3000 and the api at 127.0.0.1:4000/health.";
    const matches = [
      ...raw.matchAll(new RegExp(LOCALHOST_URL_RE.source, "g")),
    ].map((m) => m[0]);
    expect(matches).toEqual(["localhost:3000", "127.0.0.1:4000/health"]);
  });
});
