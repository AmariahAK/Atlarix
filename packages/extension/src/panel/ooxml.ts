/**
 * Text out of the ZIP-and-XML office formats, using only what the browser ships.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. Claude and ChatGPT both accept .docx,
 * .xlsx and .pptx, and both extract them ON THEIR SERVERS — their extensions are
 * thin clients posting bytes to a backend. We have no file backend, and this
 * package deliberately ships no dependencies: the Chrome Web Store reviews
 * un-minified source by hand, so a parser blob is a real cost measured in days.
 *
 * It turns out not to be needed. Every one of these formats is a ZIP archive of
 * XML, and Chrome has shipped `DecompressionStream("deflate-raw")` since 103 —
 * this extension's manifest floor is 116. So the archive can be opened with a
 * central-directory read and the browser's own inflater, and the text pulled out
 * of the parts that hold it. That is this file.
 *
 * WHAT IT DOES NOT DO, deliberately: layout, styles, images, formulas, revision
 * history, or anything encrypted. It returns the words, in reading order, which
 * is what a model asked "what does this say" needs. A spreadsheet comes back as
 * tab-separated rows rather than a grid, because that is what it is.
 *
 * NOTHING HERE THROWS ON BAD INPUT. A corrupt or password-protected file must
 * come back as null so the caller can say so plainly, not as an exception inside
 * a paste handler.
 */

/** ZIP end-of-central-directory signature, little-endian. */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The first four bytes of every ZIP archive. */
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export type ArchiveFormat = "docx" | "xlsx" | "pptx" | "odt" | "epub";

/** Does this look like a ZIP at all? Cheap, and the gate for trying. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

interface Entry {
  name: string;
  /** Offset of the local file header. */
  offset: number;
  compression: number;
  compressedSize: number;
}

/**
 * The archive's table of contents.
 *
 * READ FROM THE END, which is how ZIP is meant to be read and not merely a
 * shortcut: the local headers at the front may carry zeroed sizes with the real
 * ones in a data descriptor AFTER the payload, so a front-to-back scan cannot
 * know where an entry stops. The central directory always knows.
 */
function readCentralDirectory(buf: Uint8Array): Entry[] | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The EOCD is last, but a trailing comment may follow it — so scan backwards
  // for the signature rather than assuming a fixed offset. 64 KB is the largest
  // comment ZIP permits.
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: Entry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buf.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      // A truncated or Zip64 directory. Return what was read rather than
      // nothing: a .docx whose first entries parsed still yields its text.
      break;
    }
    const compression = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      buf.subarray(at + 46, at + 46 + nameLength),
    );
    entries.push({ name, offset, compression, compressedSize });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** One entry's bytes, inflated if it needs it. */
async function readEntry(
  buf: Uint8Array,
  entry: Entry,
): Promise<string | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const header = entry.offset;
  if (header + 30 > buf.length) return null;

  // The local header repeats the name and extra fields, and its extra length
  // frequently DIFFERS from the central one — reading the central value here is
  // an off-by-a-few-bytes that decodes to garbage.
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const start = header + 30 + nameLength + extraLength;

  // Prefer the central directory's size; fall back to the rest of the buffer,
  // which the inflater will stop at the end of the stream anyway.
  const end =
    entry.compressedSize > 0
      ? Math.min(start + entry.compressedSize, buf.length)
      : buf.length;
  const payload = buf.subarray(start, end);

  if (entry.compression === 0) return new TextDecoder().decode(payload);
  if (entry.compression !== 8) return null; // Only stored and deflate exist here.

  try {
    return await inflateRaw(payload);
  } catch {
    // Encrypted, or not actually deflate. The caller says so.
    return null;
  }
}

/**
 * Raw-deflate bytes to text, through the browser's own decompressor.
 *
 * FED FROM A `ReadableStream` RATHER THAN `new Blob([…]).stream()`, which is the
 * obvious spelling and the one that cannot be tested: jsdom's `Blob` has no
 * `.stream()`, so every office-document test would have to be skipped and this
 * reader would ship unverified. A stream of one chunk is what `Blob.stream()`
 * produces anyway, with one fewer object in the way.
 */
async function inflateRaw(payload: Uint8Array): Promise<string> {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(payload as BufferSource);
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();

  // Decoded incrementally with `stream: true` so a multi-byte character split
  // across two chunks is not turned into a replacement character.
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/* ── XML → text ───────────────────────────────────────────────────────────── */

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/**
 * The words in an XML document, with paragraph breaks preserved.
 *
 * BY HAND RATHER THAN `DOMParser`, for two reasons that both bite in practice:
 * these documents use namespaced element names that the caller would then have
 * to walk generically anyway, and a 40 MB spreadsheet built into a DOM costs far
 * more memory than the text it contains. Stripping tags is what we actually
 * want, and it cannot fail on a document fragment.
 *
 * The paragraph-ending tags are listed per format because the alternative —
 * breaking at every tag — puts a newline between every styled run, so a
 * sentence with one bold word becomes three lines.
 */
const PARAGRAPH_END =
  /<\/(w:p|a:p|text:p|text:h|w:tr|text:table-row)\s*>/g;
const TAB = /<\/(w:tab|text:tab)\s*\/?>|<w:tab\s*\/>/g;
const BREAK = /<(w:br|a:br|text:line-break)\s*\/?>/g;

export function xmlToText(xml: string): string {
  // CDATA IS SET ASIDE, NOT UNWRAPPED IN PLACE. Unwrapping first puts its
  // literal `<` into the document, where the tag stripper below eats it and
  // everything after it up to the next `>` — silently losing content that was
  // marked CDATA precisely because it contains angle brackets. Held out behind a
  // sentinel that cannot occur in XML text, it survives both passes.
  const held: string[] = [];
  const guarded = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body: string) => {
    held.push(body);
    return ` ${held.length - 1} `;
  });

  return decodeEntities(
    guarded
      .replace(PARAGRAPH_END, "\n")
      .replace(BREAK, "\n")
      .replace(TAB, "\t")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/ (\d+) /g, (_, i: string) => held[Number(i)] ?? "")
    // Collapse the blank lines that empty runs leave behind, but keep single
    // breaks — a document's paragraph structure is most of its readability.
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ── Per-format assembly ──────────────────────────────────────────────────── */

/** Natural-ish order, so slide10 does not sort before slide2. */
function byNumberedName(a: string, b: string): number {
  const n = (s: string) => Number.parseInt(/(\d+)\D*$/.exec(s)?.[1] ?? "0", 10);
  return n(a) - n(b) || a.localeCompare(b);
}

/**
 * A spreadsheet's cells, as tab-separated rows.
 *
 * SHARED STRINGS ARE THE WHOLE TRICK. Every repeated text value in an .xlsx is
 * stored once in `sharedStrings.xml` and referenced from the sheet by index —
 * a cell reading `<c t="s"><v>4</v></c>` is not the number 4, it is the fifth
 * shared string. Extracting the sheet alone yields a grid of integers that look
 * like data and are not, which is worse than extracting nothing.
 */
function xlsxText(parts: Map<string, string>): string {
  const sharedXml = parts.get("xl/sharedStrings.xml") ?? "";
  const shared: string[] = [];
  for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(xmlToText(match[1]).replace(/\n+/g, " "));
  }

  const sheets = [...parts.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n))
    .sort(byNumberedName);

  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = parts.get(sheet) ?? "";
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const isShared = /\bt="s"/.test(cell[1]);
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? "";
        if (isShared) {
          const index = Number.parseInt(raw, 10);
          cells.push(shared[index] ?? "");
        } else {
          // An inline string carries its own <is><t>; everything else is a
          // literal value.
          const inline = /<is>([\s\S]*?)<\/is>/.exec(cell[2]);
          cells.push(inline ? xmlToText(inline[1]) : decodeEntities(raw));
        }
      }
      if (cells.some((c) => c !== "")) out.push(cells.join("\t"));
    }
  }
  return out.join("\n");
}

function joinParts(parts: Map<string, string>, names: string[]): string {
  return names
    .map((n) => xmlToText(parts.get(n) ?? ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What kind of archive this is, from its entry names.
 *
 * BY CONTENT, NOT BY EXTENSION — the rule the desktop settled on after an
 * extension allowlist missed `.mjs` and `.vue` and could never match a file with
 * no extension at all. A `.docx` renamed `.zip` still reads here.
 */
export function archiveFormat(names: string[]): ArchiveFormat | null {
  const has = (n: string) => names.includes(n);
  if (has("word/document.xml")) return "docx";
  if (names.some((n) => n.startsWith("xl/worksheets/"))) return "xlsx";
  if (names.some((n) => n.startsWith("ppt/slides/slide"))) return "pptx";
  if (has("mimetype") && names.some((n) => n.endsWith(".opf"))) return "epub";
  if (has("content.xml")) return "odt";
  return null;
}

export interface ExtractResult {
  format: ArchiveFormat;
  text: string;
}

/**
 * The readable text of an office document, or null if it is not one.
 *
 * Null covers every failure the caller must explain differently from success:
 * not a zip, a zip of something else, encrypted, or corrupt past the point of
 * yielding anything.
 */
export async function extractArchiveText(
  bytes: Uint8Array,
): Promise<ExtractResult | null> {
  if (!looksLikeZip(bytes)) return null;
  const entries = readCentralDirectory(bytes);
  if (!entries || entries.length === 0) return null;

  const format = archiveFormat(entries.map((e) => e.name));
  if (!format) return null;

  // Only the parts that carry text — a .pptx full of images should not have
  // every media blob inflated to be thrown away.
  const wanted = entries.filter((e) => {
    if (format === "docx") {
      return e.name === "word/document.xml" || e.name === "word/footnotes.xml";
    }
    if (format === "xlsx") {
      return (
        e.name === "xl/sharedStrings.xml" ||
        /^xl\/worksheets\/sheet\d*\.xml$/.test(e.name)
      );
    }
    if (format === "pptx") {
      return /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(e.name);
    }
    if (format === "odt") return e.name === "content.xml";
    return e.name.endsWith(".xhtml") || e.name.endsWith(".html");
  });

  const parts = new Map<string, string>();
  for (const entry of wanted) {
    const text = await readEntry(bytes, entry);
    if (text !== null) parts.set(entry.name, text);
  }
  if (parts.size === 0) return null;

  const names = [...parts.keys()].sort(byNumberedName);
  const text =
    format === "xlsx" ? xlsxText(parts) : joinParts(parts, names);

  return text.trim() ? { format, text } : null;
}
