import { describe, expect, it } from "vitest";
import {
  buildToolModelOutput,
  extractImageMedia,
  providerSupportsToolMedia,
  redactToolMediaForDisplay,
} from "@/lib/ai/tool-model-output";

/**
 * v12 0.2 Phase A: typed tool outputs — browser screenshots become media
 * content parts on vision providers, a text fallback elsewhere (TODO 1.3).
 * W4 (v14.8.11): the gate is the RESULT SHAPE, not the tool name — attached
 * images (read_attachment) ride the same pipeline.
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
      // ai@7 replaced the flat `media` part with a `file` part whose data is a
      // TAGGED union, so a provider can tell raw bytes from a URL or an uploaded
      // reference. Same bytes, same media type — a shape change, not a
      // capability one.
      expect(value[1]).toEqual({
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: FAKE_PNG_B64 },
      });
    }
  });

  it("non-vision provider: screenshot → text fallback, never base64", () => {
    const out = buildToolModelOutput(
      "browser_screenshot",
      envelopedScreenshot,
      {
        builtinProviderId: undefined,
      },
    );
    expect(out?.type).toBe("text");
    const value = (out as any).value as string;
    expect(value).toContain("cannot view images");
    expect(value).toContain("https://example.com/docs");
    expect(value).not.toContain(FAKE_PNG_B64.slice(0, 32));
  });

  it("failure and non-image results keep the normal path (undefined)", () => {
    expect(
      buildToolModelOutput(
        "browser_screenshot",
        { success: false, error: "No browser page is open." },
        { builtinProviderId: "anthropic" },
      ),
    ).toBeUndefined();
    expect(
      buildToolModelOutput("browser_screenshot", "plain string result", {
        builtinProviderId: "anthropic",
      }),
    ).toBeUndefined();
    expect(
      buildToolModelOutput(
        "read_file",
        { success: true, result: { content: "text file body" } },
        { builtinProviderId: "anthropic" },
      ),
    ).toBeUndefined();
  });

  it("W4: detection is name-agnostic — any tool returning the image shape gets media", () => {
    const out = buildToolModelOutput("read_attachment", envelopedScreenshot, {
      builtinProviderId: "anthropic",
    });
    expect(out?.type).toBe("content");
  });

  it("W4: attached image → media part on vision, filename caption", () => {
    const attachmentImage = {
      success: true,
      type: "image",
      filename: "diagram.png",
      size: 1234,
      mimeType: "image/png",
      data: FAKE_PNG_B64,
      note: "User-attached image diagram.png",
    };
    const out = buildToolModelOutput("read_attachment", attachmentImage, {
      builtinProviderId: "anthropic",
    });
    expect(out?.type).toBe("content");
    const value = (out as any).value;
    expect(value[0].text).toContain("diagram.png");
    expect(value[1]).toEqual({
      type: "file",
      mediaType: "image/png",
      data: { type: "data", data: FAKE_PNG_B64 },
    });
  });

  it("W4: attached image on a non-vision provider → clean placeholder, no base64", () => {
    const attachmentImage = {
      success: true,
      filename: "diagram.png",
      mimeType: "image/png",
      data: FAKE_PNG_B64,
    };
    const out = buildToolModelOutput("read_attachment", attachmentImage, {
      builtinProviderId: undefined,
    });
    expect(out?.type).toBe("text");
    const value = (out as any).value as string;
    expect(value).toContain("diagram.png");
    expect(value).toContain("cannot view images");
    expect(value).not.toContain(FAKE_PNG_B64.slice(0, 32));
  });
});

describe("extractImageMedia", () => {
  it("requires success + image mimeType + data", () => {
    expect(extractImageMedia(rawScreenshot)?.mediaType).toBe("image/png");
    expect(extractImageMedia(envelopedScreenshot)?.data).toBe(FAKE_PNG_B64);
    expect(extractImageMedia({ success: true, data: "x" })).toBeNull();
    expect(
      extractImageMedia({ success: false, mimeType: "image/png", data: "x" }),
    ).toBeNull();
    expect(extractImageMedia(null)).toBeNull();
  });
});

describe("redactToolMediaForDisplay", () => {
  it("replaces base64 with a size placeholder (both shapes), keeps metadata", () => {
    const redactedEnv: any = redactToolMediaForDisplay(envelopedScreenshot);
    expect(redactedEnv.result.data).toContain("KB redacted");
    expect(redactedEnv.result.url).toBe("https://example.com/docs");
    expect(JSON.stringify(redactedEnv)).not.toContain(
      FAKE_PNG_B64.slice(0, 32),
    );

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
