import { describe, expect, it } from "vitest";
import { prepareMessageWithAttachments } from "@/ipc/handlers/chat_stream_handlers";

/**
 * v14.8.11 follow-on to W4: the current turn's image attachments embed as
 * NATIVE image parts in the user message on vision-capable dispatches — the
 * model sees them immediately, no read_attachment round-trip. The caller
 * gates on vision (passes [] otherwise); non-image/oversized payloads and
 * SVG stay on the tool path.
 */

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUg".repeat(20);

const baseMessage = {
  role: "user" as const,
  content: "what is in this image?",
};

describe("prepareMessageWithAttachments — image embedding", () => {
  it("embeds current-turn images as native image parts with a text lead", async () => {
    const out = await prepareMessageWithAttachments({
      message: baseMessage,
      attachmentInfoForModel: "\n\nFILES ATTACHED:\n- diagram.png",
      imageAttachments: [
        { filename: "diagram.png", mimeType: "image/png", data: PNG_B64 },
      ],
    });
    expect(Array.isArray(out.content)).toBe(true);
    const parts = out.content as Array<Record<string, unknown>>;
    expect(parts[0]!.type).toBe("text");
    expect(String(parts[0]!.text)).toContain("what is in this image?");
    expect(String(parts[0]!.text)).toContain("FILES ATTACHED");
    expect(String(parts[0]!.text)).toContain("read_attachment is NOT needed");
    // A `file` part with an image media type (AI SDK 7 deprecated `image`).
    expect(parts[1]).toEqual({
      type: "file",
      data: PNG_B64,
      filename: "diagram.png",
      mediaType: "image/png",
    });
  });

  it("no images (non-vision caller passes []) → plain string content", async () => {
    const out = await prepareMessageWithAttachments({
      message: baseMessage,
      attachmentInfoForModel: "\n\nFILES ATTACHED:\n- notes.pdf",
      imageAttachments: [],
    });
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("FILES ATTACHED");
  });

  it("non-image, svg, and oversized attachments never embed", async () => {
    const out = await prepareMessageWithAttachments({
      message: baseMessage,
      attachmentInfoForModel: "",
      imageAttachments: [
        { filename: "doc.pdf", mimeType: "application/pdf", data: PNG_B64 },
        { filename: "icon.svg", mimeType: "image/svg+xml", data: PNG_B64 },
        {
          filename: "huge.png",
          mimeType: "image/png",
          data: "x".repeat(6_800_001),
        },
      ],
    });
    expect(typeof out.content).toBe("string");
  });

  it("caps the number of embedded images at 8", async () => {
    const out = await prepareMessageWithAttachments({
      message: baseMessage,
      attachmentInfoForModel: "",
      imageAttachments: Array.from({ length: 12 }, (_, i) => ({
        filename: `img${i}.png`,
        mimeType: "image/png",
        data: PNG_B64,
      })),
    });
    const parts = out.content as Array<Record<string, unknown>>;
    expect(parts.filter((p) => p.type === "file" && String(p.mediaType).startsWith("image/"))).toHaveLength(8);
  });
});
