/**
 * Native PDF document parts.
 *
 * Until now every PDF was locally text-extracted, so a SCANNED or image-only one
 * could not be read at all — extraction returns nothing and the tool says so.
 * Capable models now receive the document itself.
 *
 * The risk this pins is the other direction: sending megabytes of PDF to a model
 * that rejects it. The gate is per-MODEL from the models.dev `pdf` input
 * modality, never per-provider — OpenAI accepts PDF on 15 of 47 catalog models,
 * so a provider-level allowlist would be wrong for most of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron-log", () => {
  const scope = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  });
  return { default: { scope, ...scope() } };
});

import {
  detectPdfCapability,
  detectVisionCapability,
  registerModelsDevVision,
} from "@/lib/routing/model-capability-profile";
import {
  prepareMessageWithAttachments,
  PDF_MIME_TYPE,
} from "@/ipc/handlers/chat_stream/message-postprocess";
import {
  isPdfContentRejectionError,
  isImageContentRejectionError,
  requestHasDocumentPart,
} from "@/lib/chat/image-embed-gate";

const pdf = (filename: string, data = "JVBERi0xLjQK") => ({
  filename,
  mimeType: PDF_MIME_TYPE,
  data,
});
const png = (filename: string, data = "iVBORw0KGgo=") => ({
  filename,
  mimeType: "image/png",
  data,
});

function partsOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? (content as Array<Record<string, unknown>>)
    : [];
}

describe("detectPdfCapability", () => {
  beforeEach(() => {
    registerModelsDevVision([
      // Sees images, accepts documents.
      {
        providerId: "openai",
        modelId: "gpt-4o",
        acceptsImages: true,
        acceptsPdf: true,
      },
      // Sees images but does NOT accept documents — the case a provider-level
      // allowlist would get wrong, on the same provider as the row above.
      {
        providerId: "openai",
        modelId: "gpt-4.1-nano",
        acceptsImages: true,
        acceptsPdf: false,
      },
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-6",
        acceptsImages: true,
        acceptsPdf: true,
      },
    ]);
  });

  it("is per-model, not per-provider", () => {
    expect(detectPdfCapability("openai", "gpt-4o")).toBe(true);
    expect(detectPdfCapability("openai", "gpt-4.1-nano")).toBe(false);
  });

  it("does not infer PDF support from vision support", () => {
    expect(detectVisionCapability("openai", "gpt-4.1-nano")).toBe(true);
    expect(detectPdfCapability("openai", "gpt-4.1-nano")).toBe(false);
  });

  /** Unknown must mean "extract locally", which is the long-standing behaviour. */
  it("is false for an unknown model and for a missing id", () => {
    expect(detectPdfCapability("openai", "some-model-nobody-published")).toBe(
      false,
    );
    expect(detectPdfCapability("anthropic", "")).toBe(false);
    expect(detectPdfCapability(undefined, undefined)).toBe(false);
  });

  it("resolves a vendor-prefixed id by its tail", () => {
    expect(
      detectPdfCapability("openrouter", "anthropic/claude-sonnet-4-6"),
    ).toBe(true);
  });

  /**
   * Core is the DEFAULT path and has no catalog rows of its own — `compass` is a
   * synthetic provider. `resolveReasoningCatalogModelId` hands us the vendor's
   * bare model id, so the lookup has to fall through the unmatched
   * `compass:<model>` key to the bare one. Getting this wrong would leave every
   * Core user silently on text extraction.
   */
  it("resolves a Core tier through the bare model id", () => {
    expect(detectPdfCapability("compass", "gpt-4o")).toBe(true);
    expect(detectPdfCapability("compass", "gpt-4.1-nano")).toBe(false);
  });
});

describe("prepareMessageWithAttachments — PDF parts", () => {
  const base = {
    message: { role: "user" as const, content: "summarise this" },
    attachmentInfoForModel: "",
  };

  it("emits a file part with the media type and filename", async () => {
    const out = await prepareMessageWithAttachments({
      ...base,
      pdfAttachments: [pdf("report.pdf")],
    });
    const parts = partsOf(out.content);
    const file = parts.find((p) => p.type === "file");
    expect(file).toBeTruthy();
    expect(file!.mediaType).toBe(PDF_MIME_TYPE);
    // Without the filename a multi-PDF turn gives the model no way to say which
    // document it is quoting.
    expect(file!.filename).toBe("report.pdf");
  });

  /**
   * The caller gates on capability, so [] is what a non-PDF model receives — and
   * it must come back as a PLAIN STRING, byte-identical to the old behaviour, or
   * every non-PDF dispatch silently changes shape.
   */
  it("returns plain string content when there is nothing to embed", async () => {
    const out = await prepareMessageWithAttachments({
      ...base,
      pdfAttachments: [],
    });
    expect(typeof out.content).toBe("string");
    expect(out.content).toBe("summarise this");
  });

  it("carries images and PDFs together, each with its own note", async () => {
    const out = await prepareMessageWithAttachments({
      ...base,
      imageAttachments: [png("shot.png")],
      pdfAttachments: [pdf("report.pdf")],
    });
    const parts = partsOf(out.content);
    // Both are `file` parts (AI SDK 7 deprecated the `image` part), told apart by media type.
    const files = parts.filter((p) => p.type === "file") as Array<{ mediaType?: string }>;
    expect(files.map((f) => f.mediaType)).toEqual(["image/png", "application/pdf"]);
    const text = String(parts.find((p) => p.type === "text")?.text ?? "");
    expect(text).toContain("shot.png");
    expect(text).toContain("report.pdf");
  });

  /** A PDF-only turn must not be told anything about images. */
  it("does not mention images on a PDF-only turn", async () => {
    const out = await prepareMessageWithAttachments({
      ...base,
      pdfAttachments: [pdf("report.pdf")],
    });
    const text = String(
      partsOf(out.content).find((p) => p.type === "text")?.text ?? "",
    );
    expect(text).not.toMatch(/attached image/i);
    expect(text).toMatch(/attached PDF/i);
  });

  it("drops an oversized PDF rather than sending it", async () => {
    const huge = pdf("huge.pdf", "A".repeat(4_200_000));
    const out = await prepareMessageWithAttachments({
      ...base,
      pdfAttachments: [huge],
    });
    // Falls all the way back to plain text — i.e. the extraction path.
    expect(typeof out.content).toBe("string");
  });

  it("caps how many PDFs ride one turn", async () => {
    const out = await prepareMessageWithAttachments({
      ...base,
      pdfAttachments: [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")],
    });
    expect(partsOf(out.content).filter((p) => p.type === "file")).toHaveLength(
      3,
    );
  });

  it("ignores a non-PDF mime type handed to the PDF slot", async () => {
    const out = await prepareMessageWithAttachments({
      ...base,
      pdfAttachments: [png("not-a-pdf.png")],
    });
    expect(typeof out.content).toBe("string");
  });
});

describe("PDF rejection detection", () => {
  it("recognises a provider refusing the document part", () => {
    const err = {
      error: {
        responseBody: "unknown variant `input_file`, expected `text` at line 1",
      },
    };
    expect(isPdfContentRejectionError(err, true)).toBe(true);
  });

  it("recognises a provider naming pdf support directly", () => {
    expect(
      isPdfContentRejectionError(
        { message: "This model does not support pdf input" },
        true,
      ),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isPdfContentRejectionError({ message: "rate limit exceeded" }, true)).toBe(
      false,
    );
    expect(isPdfContentRejectionError(undefined, true)).toBe(false);
  });

  /**
   * E1 (2026-10-20): Anthropic ends every error with "Please consult our
   * documentation at …", so any 400 (here max_tokens vs budget_tokens, seen live
   * on Bedrock Haiku 4.5) read as "The PDF you attached couldn't be sent".
   */
  it("an Anthropic 400 is not a PDF rejection, with or without a PDF on the turn", () => {
    const anthropic400 = {
      error: {
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "`max_tokens` must be greater than `thinking.budget_tokens`. Please consult our documentation at https://platform.claude.com/docs/en/build-with-claude/extended-thinking",
          },
        }),
      },
    };
    expect(isPdfContentRejectionError(anthropic400, false)).toBe(false);
    expect(isPdfContentRejectionError(anthropic400, true)).toBe(false);
  });

  it("nothing is a PDF rejection when the request carried no document", () => {
    const err = { error: { responseBody: "unknown variant `input_file`, expected `text`" } };
    expect(isPdfContentRejectionError(err, false)).toBe(false);
  });

  it("knows a request with a PDF from one with only text and images", () => {
    const text = { role: "user", content: "hi" };
    const image = { role: "user", content: [{ type: "file", mediaType: "image/png", data: "x" }] };
    const pdf = { role: "user", content: [{ type: "text", text: "read" }, { type: "file", mediaType: "application/pdf", data: "x" }] };
    expect(requestHasDocumentPart([text, image])).toBe(false);
    expect(requestHasDocumentPart([text, pdf])).toBe(true);
  });

  /**
   * The reason PDF is matched FIRST at both call sites: an image rejection also
   * trips the broad "unsupported" clauses, so whichever is checked second would
   * never be reached for an error mentioning both.
   */
  it("an image-only rejection is not claimed as a PDF one", () => {
    const err = {
      error: { responseBody: "unknown variant `image_url`, expected `text`" },
    };
    expect(isImageContentRejectionError(err)).toBe(true);
    expect(isPdfContentRejectionError(err, true)).toBe(false);
  });
});
