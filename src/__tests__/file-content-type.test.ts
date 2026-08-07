/**
 * Content-based file classification.
 *
 * This replaced a 39-entry hardcoded extension allowlist. The bug that prompted it:
 * macOS registers `.ts` as an MPEG transport stream, so a TypeScript attachment
 * arrived reporting `video/mp2t` and was handled as video. The list was also missing
 * 44 common text types (`.mjs`, `.vue`, `.ps1`, `.tf`, …) and could never match a
 * file with no extension at all (`Dockerfile`, `Makefile`).
 *
 * These tests exercise BYTES, never filenames — that is the whole point. Anything
 * that starts passing a filename in here has reintroduced the bug.
 */
import { describe, it, expect } from "vitest";
import {
  SNIFF_SAMPLE_BYTES,
  classifyContent,
  decodesAsUtf8,
  detectDocumentSignature,
  detectImageMime,
  isTextContent,
  looksBinary,
} from "@/lib/file-content-type";

const enc = (s: string) => new TextEncoder().encode(s);
/** Bytes with a signature prefix followed by filler, as a real file would have. */
const withPrefix = (sig: number[], len = 64) =>
  new Uint8Array([...sig, ...Array.from({ length: len }, (_, i) => (i % 251) + 1)]);

describe("detectImageMime — magic bytes, not names", () => {
  it.each([
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["JPEG", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
    ["BMP", [0x42, 0x4d], "image/bmp"],
    ["ICO", [0x00, 0x00, 0x01, 0x00], "image/x-icon"],
  ])("detects %s", (_label, sig, mime) => {
    expect(detectImageMime(withPrefix(sig))).toBe(mime);
  });

  it("detects GIF87a and GIF89a", () => {
    expect(detectImageMime(enc("GIF89a....."))).toBe("image/gif");
    expect(detectImageMime(enc("GIF87a....."))).toBe("image/gif");
  });

  it("detects WEBP, which needs the tag at offset 8", () => {
    // "RIFF" + 4 size bytes + "WEBP" — a naive prefix check would miss it.
    const webp = new Uint8Array([...enc("RIFF"), 1, 2, 3, 4, ...enc("WEBPVP8 ")]);
    expect(detectImageMime(webp)).toBe("image/webp");
    // RIFF alone is not an image (it is also WAV/AVI).
    expect(detectImageMime(new Uint8Array([...enc("RIFF"), 1, 2, 3, 4, ...enc("WAVE")]))).toBeNull();
  });

  it("is not fooled by a wrong extension — a JPEG named .png is still a JPEG", () => {
    // The scenario extensions get wrong and content gets right.
    expect(detectImageMime(withPrefix([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });

  it("returns null for text, so source files never look like images", () => {
    expect(detectImageMime(enc("export const x = 1;\n"))).toBeNull();
  });

  it("does not treat SVG as an image (it has no magic number)", () => {
    // Deliberate: providers reject image/svg+xml as image input, and the markup is
    // more useful to the model as text.
    expect(detectImageMime(enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });
});

describe("detectDocumentSignature", () => {
  it("detects PDF", () => {
    expect(detectDocumentSignature(enc("%PDF-1.7\n%âãÏÓ"))?.container).toBe("pdf");
  });
  it("detects RTF", () => {
    expect(detectDocumentSignature(enc("{\\rtf1\\ansi"))?.container).toBe("rtf");
  });
  it("detects ZIP containers, including empty and spanned archives", () => {
    // .docx/.xlsx/.pptx/.odt are all ZIPs — an empty one is still a document.
    expect(detectDocumentSignature(withPrefix([0x50, 0x4b, 0x03, 0x04]))?.container).toBe("zip");
    expect(detectDocumentSignature(withPrefix([0x50, 0x4b, 0x05, 0x06]))?.container).toBe("zip");
    expect(detectDocumentSignature(withPrefix([0x50, 0x4b, 0x07, 0x08]))?.container).toBe("zip");
  });
  it("returns null for plain text", () => {
    expect(detectDocumentSignature(enc("hello"))).toBeNull();
  });
});

describe("looksBinary / decodesAsUtf8", () => {
  it("treats a NUL byte as binary", () => {
    expect(looksBinary(new Uint8Array([65, 66, 0, 67]))).toBe(true);
    expect(looksBinary(enc("no nulls here"))).toBe(false);
  });

  it("rejects invalid UTF-8", () => {
    // 0xC3 starts a 2-byte sequence; 0x28 is not a valid continuation.
    expect(decodesAsUtf8(new Uint8Array([0xc3, 0x28]))).toBe(false);
  });

  it("accepts multi-byte UTF-8", () => {
    expect(decodesAsUtf8(enc("héllo → 世界 🚀"))).toBe(true);
  });
});

describe("classifyContent — the reported bug", () => {
  it("classifies TypeScript source as TEXT, not video", () => {
    // macOS reports `.ts` as video/mp2t. Content says otherwise.
    const ts = enc("export interface Foo { bar: string }\nconst x: number = 1;\n");
    expect(classifyContent(ts)).toEqual({ kind: "text", mime: "text/plain" });
  });

  it("classifies every type the old 39-entry allowlist missed", () => {
    // Representative sources for extensions absent from the deleted list. All are
    // plain UTF-8, so all must be text — and none of them needed to be enumerated.
    const samples = [
      "export default {}\n", // .mjs / .cjs / .mts / .cts
      "<script setup lang='ts'>\n</script>\n", // .vue
      "<script>let x = 1;</script>\n", // .svelte
      "$ErrorActionPreference = 'Stop'\n", // .ps1
      'resource "aws_s3_bucket" "b" {}\n', // .tf
      "const std = @import(\"std\");\n", // .zig
      "fun main() { println(\"hi\") }\n", // .kt
      "body { color: red }\n", // .scss / .less
      "syntax = \"proto3\";\n", // .proto
    ];
    for (const s of samples) {
      expect(isTextContent(enc(s))).toBe(true);
    }
  });

  it("classifies files with NO extension as text", () => {
    // Dockerfile / Makefile / LICENSE / CODEOWNERS could never match an allowlist.
    expect(isTextContent(enc("FROM node:24\nRUN npm ci\n"))).toBe(true);
    expect(isTextContent(enc("all:\n\tgcc -o out main.c\n"))).toBe(true);
    expect(isTextContent(enc("MIT License\n\nPermission is hereby granted...\n"))).toBe(true);
  });

  it("classifies real binary content as binary", () => {
    expect(classifyContent(new Uint8Array([1, 2, 0, 3, 4])).kind).toBe("binary");
    expect(classifyContent(new Uint8Array([0xc3, 0x28, 0xa0, 0xa1])).kind).toBe("binary");
  });

  it("treats an empty file as text", () => {
    // `touch new.ts` must be readable, not an opaque blob.
    expect(classifyContent(new Uint8Array([]))).toEqual({ kind: "text", mime: "text/plain" });
  });

  it("prefers a signature over the text heuristics", () => {
    expect(classifyContent(enc("%PDF-1.7\nstuff")).kind).toBe("document");
    expect(classifyContent(withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).kind).toBe(
      "image",
    );
  });

  it("returns SVG as text so the model gets readable source", () => {
    const svg = enc('<?xml version="1.0"?><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
    expect(classifyContent(svg)).toEqual({ kind: "text", mime: "text/plain" });
  });
});

describe("classifyContent — sampling", () => {
  it("does NOT misclassify text when a multi-byte char straddles the sample boundary", () => {
    // THE regression guard for `stream: true`. A fixed-size sample will sometimes
    // cut a multi-byte character in half. A non-streaming `fatal` decoder throws on
    // that truncated tail, which would report perfectly good UTF-8 as binary for any
    // file with non-ASCII content near the boundary.
    //
    // Build content so a 3-byte character (— U+2014, 0xE2 0x80 0x94) is split by the
    // 8192-byte cut: 8191 ASCII bytes, then the em dash.
    const padded = "a".repeat(SNIFF_SAMPLE_BYTES - 1) + "—" + "tail".repeat(100);
    const bytes = enc(padded);
    expect(bytes.length).toBeGreaterThan(SNIFF_SAMPLE_BYTES);
    expect(classifyContent(bytes).kind).toBe("text");
  });

  it("only inspects the head, so trailing NULs past the sample do not flip it", () => {
    // Documents the boundary honestly: this is the same tradeoff git makes.
    const head = "x".repeat(SNIFF_SAMPLE_BYTES);
    const bytes = new Uint8Array([...enc(head), 0, 0, 0]);
    expect(classifyContent(bytes).kind).toBe("text");
  });

  it("catches a NUL inside the sample", () => {
    const bytes = new Uint8Array([...enc("x".repeat(100)), 0, ...enc("y".repeat(100))]);
    expect(classifyContent(bytes).kind).toBe("binary");
  });
});
