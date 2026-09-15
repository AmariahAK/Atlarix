/**
 * The bridge's framing, fed the chunk shapes a socket actually produces.
 *
 * NONE OF THESE ARE REACHABLE BY CALLING THE READER NORMALLY, which is why they
 * are written out by hand. A socket hands over whatever the kernel had ready:
 * a large reply arrives in pieces, two small replies arrive glued together, and
 * a four-byte length prefix can be split with two bytes on each side of a chunk
 * boundary. A reader that takes a length off the front of every chunk passes a
 * naive test, works on a quiet machine, and returns nonsense on a busy one.
 */

import { describe, expect, it } from "vitest";
import {
  FrameError,
  FrameReader,
  MAX_FRAME_BYTES,
  encodeFrame,
} from "@/lib/bridge/framing";

describe("a whole frame", () => {
  it("round-trips", () => {
    const reader = new FrameReader();
    expect(reader.push(encodeFrame({ op: "hello", n: 1 }))).toEqual([
      { op: "hello", n: 1 },
    ]);
    expect(reader.pending).toBe(0);
  });

  it("counts BYTES, not characters", () => {
    // A length prefix over a character count truncates the first multi-byte
    // character and everything after it, and the symptom is a JSON parse error
    // on a message that was built correctly.
    const reader = new FrameReader();
    const value = { text: "héllo → 🌍 ünïcode" };
    const frame = encodeFrame(value);
    expect(frame.readUInt32LE(0)).toBe(
      Buffer.from(JSON.stringify(value), "utf8").length,
    );
    expect(reader.push(frame)).toEqual([value]);
  });
});

describe("the splits a socket really produces", () => {
  it("reassembles a frame delivered one byte at a time", () => {
    const reader = new FrameReader();
    const frame = encodeFrame({ hello: "world" });
    const seen: unknown[] = [];
    for (const byte of frame) {
      seen.push(...reader.push(Buffer.from([byte])));
    }
    expect(seen).toEqual([{ hello: "world" }]);
    expect(reader.pending).toBe(0);
  });

  it("survives a length prefix split across two chunks", () => {
    // The case a naive reader cannot even see: it reads a length out of two
    // bytes plus whatever follows them.
    const reader = new FrameReader();
    const frame = encodeFrame({ a: 1 });
    expect(reader.push(frame.subarray(0, 2))).toEqual([]);
    expect(reader.pending).toBe(2);
    expect(reader.push(frame.subarray(2))).toEqual([{ a: 1 }]);
  });

  it("returns several frames glued into one chunk", () => {
    const reader = new FrameReader();
    const glued = Buffer.concat([
      encodeFrame({ n: 1 }),
      encodeFrame({ n: 2 }),
      encodeFrame({ n: 3 }),
    ]);
    expect(reader.push(glued)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("keeps a trailing partial frame for the next chunk", () => {
    const reader = new FrameReader();
    const first = encodeFrame({ n: 1 });
    const second = encodeFrame({ n: 2 });
    const chunk = Buffer.concat([first, second.subarray(0, 3)]);

    expect(reader.push(chunk)).toEqual([{ n: 1 }]);
    expect(reader.pending).toBe(3);
    expect(reader.push(second.subarray(3))).toEqual([{ n: 2 }]);
  });

  it("carries a payload larger than any plausible socket chunk", () => {
    const reader = new FrameReader();
    const big = { payload: "y".repeat(900_000) };
    const frame = encodeFrame(big);

    const seen: unknown[] = [];
    for (let at = 0; at < frame.length; at += 64 * 1024) {
      seen.push(...reader.push(frame.subarray(at, at + 64 * 1024)));
    }
    expect(seen).toEqual([big]);
  });
});

describe("a stream that has gone wrong says so", () => {
  it("refuses an absurd length rather than allocating it", () => {
    const reader = new FrameReader();
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    expect(() => reader.push(head)).toThrow(FrameError);
  });

  it("names a body that is not JSON instead of returning undefined", () => {
    const reader = new FrameReader();
    const body = Buffer.from("{not json", "utf8");
    const head = Buffer.allocUnsafe(4);
    head.writeUInt32LE(body.length, 0);
    expect(() => reader.push(Buffer.concat([head, body]))).toThrow(/not JSON/);
  });

  // NO TEST FOR THE `Buffer.from` COPY IN `push`, deliberately. One was written
  // here — "does not hand back a view into a buffer it is about to reuse" — and
  // it passed against the copy REMOVED, because `JSON.parse` has already built
  // its own strings by then and the parsed values were never at risk. The copy
  // is about not retaining a large parent allocation behind a few leftover
  // bytes, which is a memory property rather than an observable one. A test
  // that cannot fail is worse than no test: it reports coverage it does not
  // have.
});
