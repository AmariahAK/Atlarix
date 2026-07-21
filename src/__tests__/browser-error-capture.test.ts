import { describe, expect, it } from "vitest";
import {
  tryParseErrorSentinel,
  ERROR_SENTINEL,
} from "@/lib/browser/error-hook";
import {
  LOCALHOST_URL_RE,
  isBareLocalhostUrl,
} from "@/lib/browser/localhost-url";

describe("tryParseErrorSentinel (injected-hook relay, no double-capture)", () => {
  it("parses a sentinel console message into a structured error WITH stack", () => {
    const rec = {
      type: "console-error",
      level: "error",
      message: "boom",
      stack: "Error: boom\n    at foo (app.js:10:5)",
      url: "http://localhost:3000/app.js",
    };
    const msg = ERROR_SENTINEL + JSON.stringify(rec);
    const parsed = tryParseErrorSentinel(msg);
    expect(parsed).toMatchObject({
      type: "console-error",
      level: "error",
      message: "boom",
      url: "http://localhost:3000/app.js",
    });
    expect(parsed?.stack).toContain("at foo (app.js:10:5)");
    // No timestamp — the caller stamps it.
    expect((parsed as Record<string, unknown>).timestamp).toBeUndefined();
  });

  it("returns null for a normal console message (plain path handles it → no duplicate)", () => {
    expect(tryParseErrorSentinel("TypeError: x is not a function")).toBeNull();
    expect(tryParseErrorSentinel("")).toBeNull();
  });

  it("returns null for a malformed sentinel payload (never throws)", () => {
    expect(tryParseErrorSentinel(ERROR_SENTINEL + "{not json")).toBeNull();
    // Sentinel present but no message field → not a usable error.
    expect(tryParseErrorSentinel(ERROR_SENTINEL + JSON.stringify({ foo: 1 }))).toBeNull();
  });

  it("preserves warning level and defaults type to console-error", () => {
    const msg = ERROR_SENTINEL + JSON.stringify({ level: "warning", message: "hmm" });
    const parsed = tryParseErrorSentinel(msg);
    expect(parsed?.level).toBe("warning");
    expect(parsed?.type).toBe("console-error");
  });
});

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
    const raw = "Your app is at localhost:3000 and the api at 127.0.0.1:4000/health.";
    const matches = [...raw.matchAll(new RegExp(LOCALHOST_URL_RE.source, "g"))].map((m) => m[0]);
    expect(matches).toEqual(["localhost:3000", "127.0.0.1:4000/health"]);
  });
});
