import { describe, expect, it } from "vitest";
import {
  decodeSentryCharCodeMessage,
  normalizeSentryErrorText,
} from "@/lib/sentry-decode-message";

describe("decodeSentryCharCodeMessage", () => {
  it("decodes comma-separated char codes to text", () => {
    const encoded =
      "105,110,118,97,108,105,100,32,112,97,116,116,101,114,110,32,105,110,32,108,111,111,107,45,98,101,104,105,110,100";
    expect(decodeSentryCharCodeMessage(encoded)).toBe(
      "invalid pattern in look-behind",
    );
  });

  it("returns plain messages unchanged", () => {
    expect(normalizeSentryErrorText("OnigScanner error")).toBe(
      "OnigScanner error",
    );
  });
});
