import { describe, expect, it } from "vitest";
import type { CoreModel } from "../core/client";
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TEXT_CHARS,
  buildUserContent,
  capabilityOf,
  classify,
  gateAttachments,
  readAttachment,
  tiersSupporting,
  type Attachment,
} from "./attachments";

const model = (
  tier: string,
  id: string,
  inputModalities: string[],
): CoreModel => ({
  id,
  tier,
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
  inputModalities,
});

/** The real lineup: Core 1 is GLM and is text-only. */
const LINEUP = [
  model("core-1", "z-ai/glm-5.3", ["text"]),
  model("core-2", "openai/gpt-5.6-terra", ["text", "image"]),
  model("core-3", "openai/gpt-6-astra", ["text", "image", "pdf"]),
];

const file = (name: string, kind: Attachment["kind"], data = "x"): Attachment => ({
  name,
  kind,
  size: data.length,
  data,
});

describe("classify", () => {
  it("reads source code by extension, not by the type the OS claims", () => {
    // A `.ts` file arrives as `video/mp2t` on most systems — an MPEG transport
    // stream. Believing the OS would refuse TypeScript as video.
    expect(classify("loop.ts", "video/mp2t")).toBe("text");
    expect(classify("notes.md", "application/octet-stream")).toBe("text");
    expect(classify("data.csv", "")).toBe("text");
  });

  it("still believes a declared text type for an unknown extension", () => {
    expect(classify("Makefile", "text/plain")).toBe("text");
    expect(classify("weird.qqq", "text/x-something")).toBe("text");
  });

  it("separates images from documents", () => {
    expect(classify("shot.png", "image/png")).toBe("image");
    expect(classify("report.pdf", "application/pdf")).toBe("pdf");
    // By extension too — a PDF with no declared type is still a PDF.
    expect(classify("report.pdf", "")).toBe("pdf");
  });

  it("refuses what it has no way to read", () => {
    expect(classify("clip.mp4", "video/mp4")).toBeNull();
    expect(classify("app.zip", "application/zip")).toBeNull();
  });
});

describe("capability gating", () => {
  it("lets a text file through on every tier, including the text-only one", () => {
    // Gating a spreadsheet on a vision flag would refuse a CSV to a model
    // perfectly able to read one. This is most of what people attach.
    const out = gateAttachments([file("q.csv", "text")], LINEUP[0], LINEUP);
    expect(out.accepted).toHaveLength(1);
    expect(out.refusals).toEqual([]);
  });

  it("refuses an image on Core 1 and names a tier that works", () => {
    // THE CASE THE PLAN CALLS OUT. Core 1 is GLM and is text-only. A refusal
    // that only states the fact leaves the user to go and find out which tier
    // can; naming one is the same sentence with the work done.
    const out = gateAttachments([file("shot.png", "image")], LINEUP[0], LINEUP);
    expect(out.accepted).toEqual([]);
    expect(out.refusals[0]).toContain("shot.png");
    expect(out.refusals[0]).toContain("Core 2");
    expect(out.refusals[0]).toContain("Core 3");
  });

  it("gates PDFs separately from images, with no vision fallback", () => {
    // Seeing an image and accepting a document are separate capabilities in
    // every catalog that reports both, and a model with vision routinely
    // rejects a document part.
    const out = gateAttachments([file("r.pdf", "pdf")], LINEUP[1], LINEUP);
    expect(out.accepted).toEqual([]);
    expect(out.refusals[0]).toContain("Core 3");
    expect(gateAttachments([file("r.pdf", "pdf")], LINEUP[2], LINEUP).accepted)
      .toHaveLength(1);
  });

  it("lets an image through when the catalog says nothing", () => {
    // No modalities means models.dev had no row, not that the model is blind.
    // Refusing on missing metadata breaks a working attachment because a
    // third-party catalog was incomplete — the wrong way to be wrong.
    const unknown = model("core-9", "vendor/new", []);
    expect(capabilityOf(unknown).known).toBe(false);
    const out = gateAttachments([file("shot.png", "image")], unknown, LINEUP);
    expect(out.accepted).toHaveLength(1);
  });

  it("caps how many images ride one message", () => {
    const many = Array.from({ length: MAX_IMAGES + 3 }, (_, i) =>
      file(`shot-${i}.png`, "image"),
    );
    const out = gateAttachments(many, LINEUP[2], LINEUP);
    expect(out.accepted).toHaveLength(MAX_IMAGES);
    expect(out.refusals).toHaveLength(3);
  });

  it("says so plainly when no tier can read the kind at all", () => {
    const textOnly = [LINEUP[0]];
    const out = gateAttachments([file("r.pdf", "pdf")], textOnly[0], textOnly);
    expect(out.refusals[0]).toMatch(/no Atlarix Core tier/i);
  });

  it("lists the tiers that support a kind", () => {
    expect(tiersSupporting(LINEUP, "image")).toEqual(["Core 2", "Core 3"]);
    expect(tiersSupporting(LINEUP, "pdf")).toEqual(["Core 3"]);
  });
});

describe("building the message", () => {
  it("stays a plain string when nothing is attached", () => {
    // Every stored transcript holds strings. A message that became a parts
    // array for no reason would be a migration nobody benefits from.
    expect(buildUserContent("hello", [])).toBe("hello");
  });

  it("puts the question before the files it is about", () => {
    // A model handed four images and then a question re-reads them with the
    // question in mind; handed the question first, it knows what to look for.
    const parts = buildUserContent("what is in this?", [
      file("a.csv", "text", "name,total\\nx,1"),
      file("shot.png", "image", "data:image/png;base64,AAA"),
    ]);
    expect(Array.isArray(parts)).toBe(true);
    const list = parts as Array<{ type: string }>;
    expect(list[0].type).toBe("text");
    expect(list[1].type).toBe("image_url");
  });

  it("inlines a text file fenced and named", () => {
    // Without the name, "what is in the second file" is unanswerable. Without
    // the fence, a CSV's commas read as prose.
    const parts = buildUserContent("check this", [
      file("totals.csv", "text", "name,total"),
    ]) as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toContain("totals.csv");
    expect(parts[0].text).toContain("```");
    expect(parts[0].text).toContain("name,total");
  });

  it("says when a text file was truncated", () => {
    // A silently clipped spreadsheet is one the model will confidently report
    // the wrong total for.
    const parts = buildUserContent("sum it", [
      { name: "big.csv", kind: "text", size: 1, data: "a", truncated: true },
    ]) as Array<{ text?: string }>;
    expect(parts[0].text).toMatch(/truncated/i);
  });

  it("sends a PDF as a document part, not as an image", () => {
    const parts = buildUserContent("read it", [
      file("r.pdf", "pdf", "data:application/pdf;base64,AAA"),
    ]) as Array<{ type: string }>;
    expect(parts[1].type).toBe("file");
  });
});

describe("reading a file", () => {
  const readers = {
    text: async (f: File) => `contents of ${f.name}`,
    dataUrl: async (f: File) => `data:${f.type};base64,AAA-${f.name}`,
  };
  const fakeFile = (name: string, type: string, size: number) =>
    ({ name, type, size }) as File;

  it("refuses what it cannot read, and says what it can", async () => {
    const out = await readAttachment(fakeFile("clip.mp4", "video/mp4", 10), readers);
    expect(out.attachment).toBeNull();
    expect(out.refusal).toMatch(/text files, images and PDFs/);
  });

  it("checks size BEFORE reading", async () => {
    // A 400 MB video read into a data URL freezes the panel for as long as it
    // takes, and is then refused anyway.
    let read = false;
    const out = await readAttachment(
      fakeFile("huge.png", "image/png", MAX_IMAGE_BYTES + 1),
      {
        text: readers.text,
        dataUrl: async (f) => {
          read = true;
          return readers.dataUrl(f);
        },
      },
    );
    expect(read).toBe(false);
    expect(out.attachment).toBeNull();
    expect(out.refusal).toMatch(/limit/i);
  });

  it("truncates a huge text file rather than refusing it", async () => {
    // The first part of a CSV answers most questions about it; "your file is
    // too big" answers none of them.
    const out = await readAttachment(fakeFile("big.csv", "text/csv", 1), {
      text: async () => "x".repeat(MAX_TEXT_CHARS + 5_000),
      dataUrl: readers.dataUrl,
    });
    expect(out.attachment?.truncated).toBe(true);
    expect(out.attachment?.data).toHaveLength(MAX_TEXT_CHARS);
  });

  it("reads an image as a data URL", async () => {
    const out = await readAttachment(fakeFile("a.png", "image/png", 10), readers);
    expect(out.attachment?.kind).toBe("image");
    expect(out.attachment?.data).toMatch(/^data:image\/png/);
  });
});
