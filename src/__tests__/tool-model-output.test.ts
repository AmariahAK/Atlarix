import { describe, expect, it } from "vitest";
import {
  buildToolModelOutput,
  extractScreenshotMedia,
  providerSupportsToolMedia,
  redactToolMediaForDisplay,
} from "@/lib/ai/tool-model-output";

/**
 * v12 0.2 Phase A: typed tool outputs — browser_screenshot becomes a media
 * content part on vision providers, a text fallback elsewhere (TODO 1.3).
 */

const FAKE_PNG_B64 = "iVBORw0KGgoAAAANSUhEUg".repeat(40); // >256 chars

const rawScreenshot = {
  success: true,
  url: "https://example.com/docs",
  title: "Example Docs",
  origin: "https://example.com",
  mimeType: "image/png",
  data: FAKE_PNG_B64,
  note: "Screenshot of untrusted page content from https://example.com.",
};

const envelopedScreenshot = {
  success: true,
  result: rawScreenshot,
  cost: 2,
  _truncatedOutput: false,
};

describe("providerSupportsToolMedia", () => {
  it("allows the vision allowlist, denies custom/unknown", () => {
    expect(providerSupportsToolMedia("anthropic")).toBe(true);
    expect(providerSupportsToolMedia("openai")).toBe(true);
    expect(providerSupportsToolMedia("google")).toBe(true);
    expect(providerSupportsToolMedia("ollama")).toBe(false);
    expect(providerSupportsToolMedia(undefined)).toBe(false); // custom providers
  });
});

describe("buildToolModelOutput", () => {
  it("vision provider: screenshot → content with media part (both shapes)", () => {
    for (const shape of [rawScreenshot, envelopedScreenshot]) {
      const out = buildToolModelOutput("browser_screenshot", shape, {
        builtinProviderId: "anthropic",
      });
      expect(out?.type).toBe("content");
      const value = (out as any).value;
      expect(value[0]).toEqual({
        type: "text",
        text: expect.stringContaining("https://example.com/docs"),
      });
      expect(value[1]).toEqual({
        type: "media",
        data: FAKE_PNG_B64,
        mediaType: "image/png",
      });
    }
  });

  it("non-vision provider: screenshot → text fallback, never base64", () => {
    const out = buildToolModelOutput("browser_screenshot", envelopedScreenshot, {
      builtinProviderId: undefined,
    });
    expect(out?.type).toBe("text");
    const value = (out as any).value as string;
    expect(value).toContain("cannot view images");
    expect(value).toContain("https://example.com/docs");
    expect(value).not.toContain(FAKE_PNG_B64.slice(0, 32));
  });

  it("failure results and other tools keep the normal path (undefined)", () => {
    expect(
      buildToolModelOutput(
        "browser_screenshot",
        { success: false, error: "No browser page is open." },
        { builtinProviderId: "anthropic" },
      ),
    ).toBeUndefined();
    expect(
      buildToolModelOutput("read_file", envelopedScreenshot, {
        builtinProviderId: "anthropic",
      }),
    ).toBeUndefined();
    expect(
      buildToolModelOutput("browser_screenshot", "plain string result", {
        builtinProviderId: "anthropic",
      }),
    ).toBeUndefined();
  });
});

describe("extractScreenshotMedia", () => {
  it("requires success + image mimeType + data", () => {
    expect(extractScreenshotMedia(rawScreenshot)?.mediaType).toBe("image/png");
    expect(extractScreenshotMedia(envelopedScreenshot)?.data).toBe(FAKE_PNG_B64);
    expect(extractScreenshotMedia({ success: true, data: "x" })).toBeNull();
    expect(
      extractScreenshotMedia({ success: false, mimeType: "image/png", data: "x" }),
    ).toBeNull();
    expect(extractScreenshotMedia(null)).toBeNull();
  });
});

describe("redactToolMediaForDisplay", () => {
  it("replaces base64 with a size placeholder (both shapes), keeps metadata", () => {
    const redactedEnv: any = redactToolMediaForDisplay(envelopedScreenshot);
    expect(redactedEnv.result.data).toContain("KB redacted");
    expect(redactedEnv.result.url).toBe("https://example.com/docs");
    expect(JSON.stringify(redactedEnv)).not.toContain(FAKE_PNG_B64.slice(0, 32));

    const redactedRaw: any = redactToolMediaForDisplay(rawScreenshot);
    expect(redactedRaw.data).toContain("KB redacted");
  });

  it("passes non-screenshot results through unchanged", () => {
    const other = { success: true, result: { content: "hello" } };
    expect(redactToolMediaForDisplay(other)).toBe(other);
  });

  it("D1: masks secrets in the display copy (command output result)", () => {
    const out: any = redactToolMediaForDisplay({
      success: true,
      result: "API_KEY=sk-abcdefghijklmnopqrstuvwx1234567890\ndeploy ok",
    });
    expect(out.result).toContain("[redacted secret]");
    expect(out.result).toContain("deploy ok");
    expect(out.result).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  it("D1: masks secrets in nested stdout, leaves clean output identical", () => {
    const dirty: any = redactToolMediaForDisplay({
      result: { stdout: "token=ghp_0123456789abcdef0123456789abcdef0123" },
    });
    expect(dirty.result.stdout).toBe("token=[redacted secret]");

    const clean = { success: true, result: { stdout: "all tests passed" } };
    expect(redactToolMediaForDisplay(clean)).toBe(clean);
  });
});
