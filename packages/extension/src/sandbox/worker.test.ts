/**
 * The sandbox worker: the container it writes, and the API it gives the model.
 *
 * WHAT IS WORTH PINNING HERE, and each one fails silently rather than loudly:
 *
 *  - **The ZIP has to be a real ZIP.** Every offset in the central directory is
 *    written from a running total, so an off-by-one produces an archive that
 *    looks plausible, has the right size, and opens NOWHERE — with no error
 *    anyone can act on. The test reads the container back rather than checking
 *    that bytes were produced.
 *  - **The result must survive the model's code.** The run replaces the
 *    worker's `postMessage` so model code cannot forge a result. The first
 *    version of that read `host.postMessage` at finish time, resolved the
 *    replacement, and posted every real result into a no-op — so every run
 *    would have died by timeout. Nothing about that is visible in a type.
 *  - **A throw must not discard the files already made.** Code that wrote three
 *    sheets and then divided by zero did real work, and dropping it would make
 *    the user re-run everything.
 *  - **`emit` must throw on a refusal, never return quietly.** A cap that is
 *    silently ignored produces a run that reports success and hands over
 *    nothing, and the model then describes a file the user does not have.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  buildZip,
  crc32,
  formatValue,
  guessMime,
  install,
  safeName,
  toBytes,
  type SandboxLimits,
  type WorkerResult,
} from "./worker";

// ---------------------------------------------------------------------------
// A ZIP reader, so the writer is checked against the format and not itself
// ---------------------------------------------------------------------------

interface ReadEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Read via the LOCAL header, using the central directory's offset. */
  payload: Uint8Array;
}

function readZip(buf: Uint8Array): ReadEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ReadEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) {
      throw new Error(`central directory entry ${i} has the wrong signature`);
    }
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      buf.subarray(at + 46, at + 46 + nameLength),
    );

    if (view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error(`"${name}" points at something that is not a local header`);
    }
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;

    entries.push({
      name,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      payload: buf.subarray(start, start + compressedSize),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }

  return entries;
}

/** Stands in for `CompressionStream`, which jsdom does not have. */
const store = async (bytes: Uint8Array) => bytes;

describe("the ZIP container", () => {
  it("round-trips several entries through a real central-directory read", async () => {
    const archive = await buildZip(
      [
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "xl/worksheets/sheet1.xml", data: "<sheetData/>" },
        { name: "empty.txt", data: "" },
      ],
      store,
    );

    const read = readZip(archive);
    expect(read.map((e) => e.name)).toEqual([
      "[Content_Types].xml",
      "xl/worksheets/sheet1.xml",
      "empty.txt",
    ]);
    // THE OFFSET IS THE POINT. Each payload is located from the central
    // directory's pointer into the local header, which is the read path every
    // real unzipper takes — an arithmetic slip anywhere lands here.
    expect(new TextDecoder().decode(read[0]!.payload)).toBe("<Types/>");
    expect(new TextDecoder().decode(read[1]!.payload)).toBe("<sheetData/>");
    expect(read[2]!.payload.length).toBe(0);
  });

  it("carries a CRC that matches the UNCOMPRESSED bytes", async () => {
    const archive = await buildZip([{ name: "a.txt", data: "hello" }], store);
    const [entry] = readZip(archive);
    expect(entry!.crc).toBe(crc32(new TextEncoder().encode("hello")));
    expect(entry!.uncompressedSize).toBe(5);
  });

  it("stores rather than deflates when deflating would not help", async () => {
    // The real case is a PNG inside an .xlsx: deflating it reliably grows it,
    // and an archive that is larger for having been compressed is a defect a
    // user would have to measure to notice.
    const archive = await buildZip([{ name: "a.bin", data: "abc" }], store);
    expect(readZip(archive)[0]!.method).toBe(0);
  });

  it("marks an entry deflated when it actually shrank", async () => {
    const shrink = async () => new Uint8Array([1, 2]);
    const archive = await buildZip([{ name: "a.txt", data: "aaaaaaaa" }], shrink);
    const [entry] = readZip(archive);
    expect(entry!.method).toBe(8);
    expect(entry!.compressedSize).toBe(2);
    expect(entry!.uncompressedSize).toBe(8);
  });

  it("is a well-formed empty archive when given nothing", async () => {
    const archive = await buildZip([], store);
    expect(archive.length).toBe(22);
    expect(readZip(archive)).toEqual([]);
  });
});

describe("crc32", () => {
  it("agrees with the published check value", () => {
    // "123456789" -> 0xCBF43926 is the standard CRC-32 check vector, so this
    // pins the polynomial and the bit order rather than our own output.
    expect(crc32(new TextEncoder().encode("123456789")) >>> 0).toBe(0xcbf43926);
  });
});

describe("coercion and labelling", () => {
  it("takes every byte-shaped thing a model reaches for", () => {
    expect([...toBytes("hi")]).toEqual([104, 105]);
    expect([...toBytes(new Uint8Array([1, 2]))]).toEqual([1, 2]);
    expect([...toBytes(new Uint8Array([1, 2]).buffer)]).toEqual([1, 2]);
    expect([...toBytes([37, 80])]).toEqual([37, 80]);
  });

  it("says what it wanted when given something else", () => {
    expect(() => toBytes({ nope: true })).toThrow(/string, a Uint8Array/);
  });

  it("cannot be talked into a path", () => {
    expect(safeName("../../etc/passwd")).toBe("etc_passwd");
    expect(safeName("a/b\\c.csv")).toBe("a_b_c.csv");
    expect(safeName("   ")).toBe("untitled");
    expect(safeName(".hidden")).toBe("hidden");
  });

  it("labels the office formats, and shrugs at the rest", () => {
    expect(guessMime("book.xlsx")).toMatch(/spreadsheetml/);
    expect(guessMime("notes.CSV")).toBe("text/csv");
    expect(guessMime("thing.qqq")).toBe("application/octet-stream");
  });

  it("prints a cycle instead of throwing inside console.log", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(formatValue(loop)).toContain("[circular]");
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Drive `install` the way a real worker would, on the real global.
 *
 * IT HAS TO BE THE GLOBAL. `new Function` compiles in global scope, so `emit`
 * and `zip` are only reachable by the model's code if they were installed
 * there — and the `postMessage` the run replaces has to be the same one the
 * code would call, or the pre-emption test proves nothing.
 *
 * The listener is intercepted rather than registered, so nothing accumulates
 * between cases and no stray `message` event can trigger a run.
 */
const LIMITS: SandboxLimits = {
  stdoutChars: 200,
  fileBytes: 1_000,
  totalBytes: 1_500,
  maxFiles: 2,
};

const globals = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();

function stash(...keys: string[]): void {
  for (const key of keys) {
    if (!saved.has(key)) saved.set(key, globals[key]);
  }
}

afterEach(() => {
  for (const [key, value] of saved) globals[key] = value;
  saved.clear();
});

async function run(
  code: string,
  opts: { inputs?: unknown[]; limits?: SandboxLimits } = {},
): Promise<Omit<WorkerResult, "kind">> {
  stash("console", "emit", "zip", "inputs", "postMessage", "addEventListener");

  const posted: unknown[] = [];
  globals.postMessage = (message: unknown) => {
    posted.push(message);
  };

  let listener: ((event: MessageEvent) => void) | null = null;
  const realAdd = globals.addEventListener as (t: string, f: unknown) => void;
  globals.addEventListener = (type: string, fn: unknown) => {
    if (type === "message") listener = fn as (event: MessageEvent) => void;
    else realAdd.call(globals, type, fn);
  };

  install(globals as never);
  globals.addEventListener = realAdd;

  const fire = listener as unknown as (event: MessageEvent) => void;
  fire({
    data: {
      kind: "atlarix:worker-run",
      code,
      inputs: opts.inputs ?? [],
      limits: opts.limits ?? LIMITS,
    },
  } as MessageEvent);

  // The run is a promise chain; a handful of microtask turns settles it, and a
  // real timer would make every case in this file slow for no extra coverage.
  for (let i = 0; i < 50 && posted.length === 0; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }

  const result = posted[0] as WorkerResult | undefined;
  if (!result) throw new Error("the worker never answered");
  const { kind: _kind, ...rest } = result;
  return rest;
}

describe("running the model's code", () => {
  it("answers even though the run replaced postMessage", async () => {
    // THE HEADLINE. `finish` captures the real `postMessage` before the run
    // shadows it. Read at finish time instead, it resolves the no-op that keeps
    // model code from forging a result — and every run dies by timeout with
    // nothing anywhere saying why.
    const result = await run('console.log("alive")');
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("alive");
  });

  it("gives the model's code no way to speak as the worker", async () => {
    const result = await run(
      'postMessage({ kind: "atlarix:worker-done", ok: true, files: [] }); console.log("after");',
    );
    // One answer, and it is ours: the forged one went into the no-op.
    expect(result.stdout).toBe("after");
    expect(result.files).toEqual([]);
  });

  it("collects emitted files with their type worked out from the name", async () => {
    const result = await run('emit("rows.csv", "a,b\\n1,2\\n")');
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe("rows.csv");
    expect(result.files[0]!.mime).toBe("text/csv");
    expect(new TextDecoder().decode(result.files[0]!.bytes)).toBe("a,b\n1,2\n");
  });

  it("copies the bytes, so later mutation cannot change a handed-over file", async () => {
    const result = await run(
      'const b = new Uint8Array([1,2,3]); emit("x.bin", b); b[0] = 99;',
    );
    expect([...result.files[0]!.bytes]).toEqual([1, 2, 3]);
  });

  it("keeps the files a run made before it threw", async () => {
    const result = await run('emit("part.csv", "a"); throw new Error("boom");');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
    expect(result.files.map((f) => f.name)).toEqual(["part.csv"]);
  });

  it("refuses a file over the limit LOUDLY", async () => {
    // Quietly dropping it would report success and hand over nothing, and the
    // model's next move is to describe a file the user does not have.
    const result = await run('emit("big.bin", new Uint8Array(2000))');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/per-file limit/);
    expect(result.files).toEqual([]);
  });

  it("refuses past the file count", async () => {
    const result = await run(
      'emit("a.txt","a"); emit("b.txt","b"); emit("c.txt","c");',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/2 files/);
    expect(result.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("says the output was cut rather than quietly shortening it", async () => {
    const result = await run('console.log("x".repeat(500))');
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(200);
  });

  it("reports a syntax error as one, without running anything", async () => {
    const result = await run("this is not javascript(");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not parse/);
  });

  it("allows top-level await and a returned value", async () => {
    const result = await run(
      "const n = await Promise.resolve(41); return n + 1;",
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe("42");
  });

  it("hands the requested inputs through untouched", async () => {
    const result = await run("return inputs[0].text.toUpperCase();", {
      inputs: [{ name: "a.txt", type: "text/plain", bytes: new Uint8Array(), text: "hi" }],
    });
    expect(result.value).toBe("HI");
  });
});
