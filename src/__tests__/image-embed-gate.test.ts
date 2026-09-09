import { describe, it, expect } from "vitest";
import {
  imageUnsupportedUserMessage,
  isImageContentRejectionError,
} from "@/lib/chat/image-embed-gate";

describe("imageUnsupportedUserMessage", () => {
  it("is friendly and actionable (tells the user to switch to a vision model)", () => {
    const msg = imageUnsupportedUserMessage();
    expect(msg.toLowerCase()).toContain("vision");
    expect(msg.toLowerCase()).toContain("switch");
    // No raw JSON / deserialize noise.
    expect(msg).not.toContain("image_url");
    expect(msg).not.toContain("deserialize");
  });
});

describe("isImageContentRejectionError", () => {
  it("matches DeepSeek's text-only chat-API rejection (the observed error)", () => {
    const msg =
      "Failed to deserialize the JSON body into the target type: messages[2]: " +
      "unknown variant `image_url`, expected `text` at line 1 column 60477";
    expect(isImageContentRejectionError(new Error(msg))).toBe(true);
    expect(isImageContentRejectionError(msg)).toBe(true);
  });

  it("matches when the detail is in a nested responseBody (real SDK error shape)", () => {
    // The image_url text lives in error.error.responseBody, NOT the top-level
    // message — the shape simple-stream-text.ts reads.
    const sdkError = {
      message: "This model failed",
      error: {
        message: "This model failed",
        responseBody: JSON.stringify({
          error: {
            message:
              "Failed to deserialize the JSON body into the target type: messages[1]: unknown variant `image_url`, expected `text`",
            type: "invalid_request_error",
            code: "invalid_request_error",
          },
        }),
      },
    };
    expect(isImageContentRejectionError(sdkError)).toBe(true);
  });

  it("matches common phrasings that name the image part or capability", () => {
    expect(
      isImageContentRejectionError(
        new Error("invalid_request_error: image_url is not supported"),
      ),
    ).toBe(true);
    expect(
      isImageContentRejectionError(
        new Error("This model does not support images"),
      ),
    ).toBe(true);
    expect(
      isImageContentRejectionError(
        new Error("input_image content is unsupported"),
      ),
    ).toBe(true);
  });

  it("does NOT match unrelated errors (no false strip)", () => {
    expect(isImageContentRejectionError(new Error("fetch failed"))).toBe(false);
    expect(
      isImageContentRejectionError(new Error("rate limit exceeded (429)")),
    ).toBe(false);
    expect(
      isImageContentRejectionError(new Error("context length exceeded")),
    ).toBe(false);
    // Mentions "image" but not a rejection — must not trip.
    expect(
      isImageContentRejectionError(
        new Error("generated an image successfully"),
      ),
    ).toBe(false);
    expect(isImageContentRejectionError(undefined)).toBe(false);
    expect(isImageContentRejectionError(null)).toBe(false);
  });
});
