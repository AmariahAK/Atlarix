import { describe, expect, it } from "vitest";
import type { CoreModel } from "../core/client";
import { PREVIEW_CHARS } from "../attachments/store";
import {
  MAX_IMAGES,
  MAX_ARCHIVE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_BYTES,
  SNIFF_BYTES,
  attachedTextPart,
  attachmentsIn,
  buildUserContent,
  capabilityOf,
  classify,
  gateAttachments,
  looksLikeText,
  readAttachedText,
  readAttachment,
  tiersSupporting,
  typedText,
  type Attachment,
  type StoredRef,
} from "./attachments";
import { BIG_DOCX_B64, DOCX_B64, XLSX_B64, bytesOf } from "./ooxml.fixtures";

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

/**
 * The real lineup, as the live proxy reports it.
 *
 * Core 1 is GLM and is text-only. BOTH GPT tiers take PDFs — `/v1/models`
 * reports `["text","image","pdf"]` for core-2 and core-3, and this fixture used
 * to claim core-2 was text+image. A fixture that disagrees with production tests
 * a product nobody ships.
 */
const LINEUP = [
  model("core-1", "z-ai/glm-5.3", ["text"]),
  model("core-2", "openai/gpt-5.6-terra", ["text", "image", "pdf"]),
  model("core-3", "openai/gpt-6-astra", ["text", "image", "pdf"]),
];
/** A lineup where only one tier takes documents, for the "names a tier" cases. */
const NARROW = [
  model("core-1", "z-ai/glm-5.3", ["text"]),
  model("core-2", "openai/gpt-5.6-terra", ["text", "image"]),
  model("core-3", "openai/gpt-6-astra", ["text", "image", "pdf"]),
];

const file = (
  name: string,
  kind: Attachment["kind"],
  data = "x",
): Attachment => ({
  name,
  kind,
  size: data.length,
  type: kind === "text" ? "text/plain" : "application/octet-stream",
  data,
});

/** What `send()` hands `buildUserContent` after writing the bodies to the store. */
const refsFor = (...files: Attachment[]): Map<string, StoredRef> =>
  new Map(
    files
      .filter((f) => f.kind === "text")
      .map((f, i) => [
        f.name,
        {
          id: `id${i}`,
          name: f.name,
          type: f.type,
          chars: f.data.length,
          preview: f.data.slice(0, PREVIEW_CHARS),
        },
      ]),
  );

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

  it("returns null to mean GO AND LOOK, not to mean refuse", () => {
    // This is the change from the old allowlist. Null used to be a refusal, so
    // a `.docx`, or a file called `Dockerfile`, never got as far as being read.
    // Now it means the name did not settle it and the bytes decide.
    expect(classify("report.docx", "")).toBeNull();
    expect(classify("mystery.bin", "")).toBeNull();
    expect(classify("clip.mp4", "video/mp4")).toBeNull();
    // `Dockerfile` is still settled by name — it is in the extension set, so it
    // never reaches the sniff. That is a shortcut, not a different answer.
    expect(classify("Dockerfile", "")).toBe("text");
  });
});

describe("looksLikeText", () => {
  it("calls a NUL byte binary", () => {
    expect(looksLikeText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false);
  });

  it("calls valid UTF-8 text, including non-English", () => {
    expect(looksLikeText(new TextEncoder().encode("héllo — καλημέρα"))).toBe(
      true,
    );
  });

  it("calls invalid UTF-8 binary", () => {
    // A lone continuation byte. A lenient decode would turn this into U+FFFD
    // and call a JPEG "text"; a strict one throws, which is the answer.
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });

  it("calls an empty file text rather than refusing it", () => {
    expect(looksLikeText(new Uint8Array())).toBe(true);
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
    // A refusal that only states the fact leaves the user to go and find out
    // which tier can; naming one is the same sentence with the work done.
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
    const out = gateAttachments([file("r.pdf", "pdf")], NARROW[1], NARROW);
    expect(out.accepted).toEqual([]);
    expect(out.refusals[0]).toContain("Core 3");
    expect(
      gateAttachments([file("r.pdf", "pdf")], NARROW[2], NARROW).accepted,
    ).toHaveLength(1);
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

  it("caps the total media one message carries", () => {
    const big = file("big.png", "image", "x".repeat(MAX_MESSAGE_BYTES - 10));
    const second = file("second.png", "image", "x".repeat(100));
    const out = gateAttachments([big, second], LINEUP[2], LINEUP);
    expect(out.accepted).toEqual([big]);
    expect(out.rejected).toEqual([second]);
    expect(out.refusals[0]).toMatch(/10 MB/);
  });

  it("does not count a text file against the message ceiling", () => {
    // THE POINT OF THE WHOLE CHANGE. A text body no longer rides the request —
    // it goes to the store and the message carries a preview — so a file far
    // past the message ceiling still sends.
    const huge = file("huge.log", "text", "x".repeat(MAX_MESSAGE_BYTES * 2));
    const out = gateAttachments([huge], LINEUP[0], LINEUP);
    expect(out.accepted).toEqual([huge]);
    expect(out.refusals).toEqual([]);
  });

  it("says so plainly when no tier can read the kind at all", () => {
    const textOnly = [LINEUP[0]];
    const out = gateAttachments([file("r.pdf", "pdf")], textOnly[0], textOnly);
    expect(out.refusals[0]).toMatch(/no Atlarix Core tier/i);
  });

  it("lists the tiers that support a kind", () => {
    expect(tiersSupporting(NARROW, "image")).toEqual(["Core 2", "Core 3"]);
    expect(tiersSupporting(NARROW, "pdf")).toEqual(["Core 3"]);
  });
});

describe("building the message", () => {
  it("stays a plain string when nothing is attached", () => {
    // Every stored transcript holds strings. A message that became a parts
    // array for no reason would be a migration nobody benefits from.
    expect(buildUserContent("hello", [], new Map())).toBe("hello");
  });

  it("puts the question before the files it is about", () => {
    // A model handed four images and then a question re-reads them with the
    // question in mind; handed the question first, it knows what to look for.
    const csv = file("a.csv", "text", "name,total\nx,1");
    const png = file("shot.png", "image", "data:image/png;base64,AAA");
    const parts = buildUserContent("what is in this?", [csv, png], refsFor(csv));
    expect(Array.isArray(parts)).toBe(true);
    const list = parts as Array<{ type: string; text?: string }>;
    // Part 0 is ALWAYS what was typed, even when that is nothing — it is what
    // `typedText` reads back, and a first part that is sometimes the question
    // and sometimes a spreadsheet supports no such rule.
    expect(list[0]).toEqual({ type: "text", text: "what is in this?" });
    expect(list[1].type).toBe("text");
    expect(list[2].type).toBe("image_url");
  });

  it("sends a preview and an id, not the file", () => {
    // THE ASSERTION THAT PINS THE WHOLE DESIGN. A transcript is re-sent in full
    // every round, so a body in the message is a body paid for every round.
    const big = file("big.csv", "text", "x".repeat(50_000));
    const parts = buildUserContent("sum it", [big], refsFor(big)) as Array<{
      text?: string;
    }>;
    expect(parts[1].text!.length).toBeLessThan(PREVIEW_CHARS + 500);
    expect(parts[1].text).toContain("big.csv");
    expect(parts[1].text).toContain("id: id0");
    expect(parts[1].text).toContain("read_attachment");
  });

  it("inlines a short file whole, with no talk of paging", () => {
    // A config file or a stack trace is usually under the preview size. Telling
    // the model to page a file it already has in full is a wasted round trip
    // and an invitation to doubt what it can see.
    const small = file("totals.csv", "text", "name,total\nx,1");
    const parts = buildUserContent(
      "check this",
      [small],
      refsFor(small),
    ) as Array<{ text?: string }>;
    expect(parts[1].text).toContain("name,total");
    expect(parts[1].text).not.toContain("read_attachment");
    expect(parts[1].text).not.toContain("Preview");
  });

  it("carries EVERY attached file, not just the first", async () => {
    // Reported as "i attached 2, and only 1 was taken". The cause was one of
    // the two being refused while being attached, with the explanation then
    // wiped from the status line by the send — but the composite path deserves
    // its own assertion, because nothing else covers two text files at once.
    const a = file("notes.md", "text", "# one");
    const b = file("totals.csv", "text", "name,total");
    const parts = buildUserContent("and these?", [a, b], refsFor(a, b));
    expect(attachmentsIn(parts).map((x) => x.name)).toEqual([
      "notes.md",
      "totals.csv",
    ]);
  });

  it("sends a PDF as a document part, not as an image", () => {
    const pdf = file("r.pdf", "pdf", "data:application/pdf;base64,AAA");
    const parts = buildUserContent("read it", [pdf], new Map()) as Array<{
      type: string;
    }>;
    expect(parts[1].type).toBe("file");
  });

  it("drops a file that never reached the store rather than inlining it", () => {
    // The fallback that would quietly undo this change: an unstored file
    // inlined "just this once" reintroduces the unbounded body on exactly the
    // path nobody tests.
    const orphan = file("lost.csv", "text", "a,b");
    const parts = buildUserContent("hi", [orphan], new Map()) as Array<unknown>;
    expect(parts).toHaveLength(1);
  });
});

describe("reading attachments back out of a sent message", () => {
  it("round-trips name, id, type and size", () => {
    const ref: StoredRef = {
      id: "9f2a",
      name: "totals.csv",
      type: "text/csv",
      chars: 50_000,
      preview: "name,total",
    };
    expect(readAttachedText(attachedTextPart(ref))).toEqual({
      id: "9f2a",
      name: "totals.csv",
      type: "text/csv",
      chars: 50_000,
      preview: "name,total",
      clipped: true,
    });
  });

  it("round-trips a filename containing the field separator", () => {
    // Parsed from the RIGHT for this reason: a filename is the one field that
    // may itself contain " | ", and splitting from the left loses half of it.
    const ref: StoredRef = {
      id: "aa",
      name: "a | b.csv",
      type: "text/csv",
      chars: 3,
      preview: "a,b",
    };
    expect(readAttachedText(attachedTextPart(ref))?.name).toBe("a | b.csv");
  });

  it("knows an unclipped preview is the whole file", () => {
    const ref: StoredRef = {
      id: "bb",
      name: "s.txt",
      type: "text/plain",
      chars: 5,
      preview: "hello",
    };
    expect(readAttachedText(attachedTextPart(ref))?.clipped).toBe(false);
  });

  it("finds every kind, named, in the order they were attached", () => {
    const csv = file("totals.csv", "text", "name,total");
    const png = file("shot.png", "image", "data:image/png;base64,AAA");
    const pdf = file("r.pdf", "pdf", "data:application/pdf;base64,AAA");
    const content = buildUserContent("what?", [csv, png, pdf], refsFor(csv));
    expect(attachmentsIn(content)).toEqual([
      {
        kind: "text",
        name: "totals.csv",
        data: "name,total",
        id: "id0",
        clipped: false,
      },
      { kind: "image", name: "Image 1", data: "data:image/png;base64,AAA" },
      { kind: "pdf", name: "r.pdf", data: "data:application/pdf;base64,AAA" },
    ]);
  });

  it("keeps the file's contents out of the typed text", () => {
    // The Edit box and the bubble both read this. Putting a CSV back in the
    // composer is not editing a question.
    const csv = file("totals.csv", "text", "name,total\nx,1");
    const content = buildUserContent("sum it", [csv], refsFor(csv));
    expect(typedText(content)).toBe("sum it");
    expect(typedText(content)).not.toContain("name,total");
  });

  it("finds nothing in an ordinary message", () => {
    expect(attachmentsIn("just a question")).toEqual([]);
    expect(typedText("just a question")).toBe("just a question");
  });

  it("does not mistake a question that starts with the header for a file", () => {
    expect(
      attachmentsIn([
        { type: "text", text: "Attached file: what does that mean?" },
      ]),
    ).toEqual([]);
  });

  it("numbers several images rather than calling them all the same thing", () => {
    // The OpenAI image part has nowhere to put a filename, so position is the
    // only name available — and "image, image, image" names nothing.
    const a = file("a.png", "image", "data:image/png;base64,AAA");
    const b = file("b.png", "image", "data:image/png;base64,BBB");
    const content = buildUserContent("compare", [a, b], new Map());
    expect(attachmentsIn(content).map((x) => x.name)).toEqual([
      "Image 1",
      "Image 2",
    ]);
  });
});

describe("reading a file", () => {
  const readers = {
    text: async (f: File) => `contents of ${f.name}`,
    dataUrl: async (f: File) => `data:${f.type};base64,AAA-${f.name}`,
    head: async () => new TextEncoder().encode("plain text"),
    bytes: async () => new TextEncoder().encode("plain text"),
  };
  /** A file the readers treat as a real archive: head is clipped, bytes is not. */
  const archive = (b64: string) => ({
    head: async () => bytesOf(b64).subarray(0, SNIFF_BYTES),
    bytes: async () => bytesOf(b64),
  });
  const fakeFile = (name: string, type: string, size: number) =>
    ({ name, type, size }) as File;

  it("checks size BEFORE reading", async () => {
    // A 400 MB image read into a data URL freezes the panel for as long as it
    // takes, and is then refused anyway.
    let read = false;
    const out = await readAttachment(
      fakeFile("huge.png", "image/png", MAX_IMAGE_BYTES + 1),
      {
        ...readers,
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

  it("does NOT truncate a huge text file", async () => {
    // The behaviour this change exists to produce. It used to clip at 200,000
    // characters and mark the attachment truncated; a clipped spreadsheet is
    // one the model confidently reports the wrong total for.
    const huge = "x".repeat(1_000_000);
    const out = await readAttachment(fakeFile("big.csv", "text/csv", 1), {
      ...readers,
      text: async () => huge,
    });
    expect(out.attachment?.data).toHaveLength(1_000_000);
    expect(out.refusal).toBeUndefined();
  });

  it("reads an image as a data URL", async () => {
    const out = await readAttachment(
      fakeFile("a.png", "image/png", 10),
      readers,
    );
    expect(out.attachment?.kind).toBe("image");
    expect(out.attachment?.data).toMatch(/^data:image\/png/);
  });

  it("reads a .docx as text, by looking at it", async () => {
    // Neither the extension nor the MIME type is consulted — the desktop's
    // rule, adopted after an allowlist missed `.mjs`, `.vue` and `Dockerfile`.
    const out = await readAttachment(
      fakeFile("report.docx", "application/octet-stream", 400),
      { ...readers, ...archive(DOCX_B64) },
    );
    expect(out.attachment?.kind).toBe("text");
    expect(out.attachment?.data).toContain("Quarterly report");
    expect(out.attachment?.type).toMatch(/wordprocessingml/);
  });

  it("reads an .xlsx with its shared strings resolved", async () => {
    const out = await readAttachment(fakeFile("book.xlsx", "", 400), {
      ...readers,
      ...archive(XLSX_B64),
    });
    expect(out.attachment?.data).toContain("EMEA");
  });

  it("recognises an office document renamed to something else", async () => {
    const out = await readAttachment(fakeFile("mystery.bin", "", 400), {
      ...readers,
      ...archive(DOCX_B64),
    });
    expect(out.attachment?.data).toContain("Quarterly report");
  });

  it("reads an archive bigger than the sniff window", async () => {
    // THE BUG THIS PINS. A ZIP's central directory is at the END of the file, so
    // extracting from the 8 KB sniff sample finds no directory and reports "not
    // an office document" — which is what every real .docx and .xlsx did. It
    // shipped because every other fixture here is under 500 bytes and so fits
    // inside the sniff window, where head and whole file are the same thing.
    const whole = bytesOf(BIG_DOCX_B64);
    expect(whole.length).toBeGreaterThan(SNIFF_BYTES);

    const out = await readAttachment(
      fakeFile("big.docx", "", whole.length),
      { ...readers, ...archive(BIG_DOCX_B64) },
    );
    expect(out.refusal).toBeUndefined();
    expect(out.attachment?.data).toContain("Paragraph 1:");
    // The last paragraph proves the whole archive was inflated, not a prefix.
    expect(out.attachment?.data).toContain("FINAL LINE MARKER");
  });

  it("refuses an archive too large to hold in memory", async () => {
    // An archive cannot be streamed — its table of contents is at the end — so
    // it is the one kind with a hard size limit.
    const out = await readAttachment(
      fakeFile("huge.docx", "", MAX_ARCHIVE_BYTES + 1),
      { ...readers, ...archive(BIG_DOCX_B64) },
    );
    expect(out.attachment).toBeNull();
    expect(out.refusal).toMatch(/25 MB/);
  });

  it("names what works when an archive is not an office document", async () => {
    const zip = new Uint8Array(200);
    zip.set([0x50, 0x4b, 0x03, 0x04]);
    const out = await readAttachment(fakeFile("stuff.zip", "", 200), {
      ...readers,
      head: async () => zip,
      bytes: async () => zip,
    });
    expect(out.attachment).toBeNull();
    expect(out.refusal).toMatch(/unpacked/i);
  });

  it("reads an extensionless text file", async () => {
    const out = await readAttachment(fakeFile("Dockerfile", "", 40), readers);
    expect(out.attachment?.kind).toBe("text");
    expect(out.attachment?.data).toBe("contents of Dockerfile");
  });

  it("refuses a real binary, and says what it does read", async () => {
    const out = await readAttachment(fakeFile("clip.mp4", "video/mp4", 10), {
      ...readers,
      head: async () => new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66]),
    });
    expect(out.attachment).toBeNull();
    expect(out.refusal).toMatch(/binary/i);
    expect(out.refusal).toMatch(/PDF/);
  });
});

/**
 * A refused attachment stays staged.
 *
 * The refusal ends "switch tier and send again", and the composer used to clear
 * every attachment on send — so following that advice meant going and finding
 * the file again. Told to do something, the user must still have the thing.
 */
describe("what survives a refusal", () => {
  const pdf = file("Resume.pdf", "pdf", "data:application/pdf;base64,AA");
  const note = file("note.txt", "text", "hello");

  it("hands back the refused ones so they can be re-sent", () => {
    const out = gateAttachments([pdf], NARROW[0], NARROW);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toEqual([pdf]);
    expect(out.refusals[0]).toContain("Core 3");
  });

  it("keeps text, which every tier reads, out of the rejected pile", () => {
    const out = gateAttachments([note, pdf], NARROW[0], NARROW);
    expect(out.accepted).toEqual([note]);
    expect(out.rejected).toEqual([pdf]);
  });

  it("rejects nothing on a tier that can read it", () => {
    const out = gateAttachments([pdf], NARROW[2], NARROW);
    expect(out.accepted).toEqual([pdf]);
    expect(out.rejected).toEqual([]);
    expect(out.refusals).toEqual([]);
  });
});
