/**
 * Chrome's native-messaging framing, which the bridge's socket also speaks.
 *
 * A message is a 4-byte length prefix in the machine's native byte order
 * followed by that many bytes of UTF-8 JSON. Every platform Chrome ships on is
 * little-endian, so `readUInt32LE` is correct and is spelled that way rather
 * than hidden behind a helper that pretends to handle big-endian.
 *
 * ══ WHY THIS IS A MODULE AND NOT FOUR LINES AT THE CALL SITE ══
 *
 * Because the four lines are wrong. A socket hands over whatever the kernel had
 * ready: a 900 KB page snapshot arrives as a dozen chunks, two small replies
 * can arrive glued into one chunk, and a length prefix can be split across a
 * chunk boundary with two of its four bytes in each. Code that reads a length
 * out of the front of every chunk works on a developer's machine and fails on a
 * loaded one, in a way that looks like the extension returning nonsense.
 *
 * `FrameReader` is therefore a state machine over a growing buffer, and the
 * tests feed it deliberately awkward splits — byte at a time, prefix straddling
 * a boundary, several frames in one chunk — because those are the shapes that
 * actually occur and none of them are reachable by calling it normally.
 *
 * ══ THE LIMIT IS A DEFENCE, NOT A TUNING KNOB ══
 *
 * A corrupt or hostile prefix claiming 4 GB would have us allocate 4 GB. The
 * cap turns that into a named error on the connection instead. It sits well
 * above any real message: requests are bytes, and the largest legitimate reply
 * is a full-page snapshot.
 */

/** Largest frame we will accept before treating the stream as corrupt. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * Chrome's own cap on a message from the host TO the extension.
 *
 * Asymmetric, and the tight limit is on the direction carrying almost nothing:
 * requests go desktop → extension and are small, while a page snapshot comes
 * back the other way where the limit is 4 GB. Exceeding it is silent — Chrome
 * drops the message — so the sending side checks rather than discovering it.
 */
export const MAX_TO_EXTENSION_BYTES = 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

export class FrameError extends Error {}

/**
 * Feed it bytes, get back whole messages.
 *
 * Holds the remainder between calls, which is the entire point — see the
 * docblock. `push` returns only the frames that completed in this chunk, and
 * never throws for an incomplete one, because incomplete is the normal state.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const out: unknown[] = [];
    for (;;) {
      // Not even a whole prefix yet. This is the case a naive reader gets
      // wrong: two of the four length bytes can sit in different chunks.
      if (this.buffer.length < 4) break;

      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        throw new FrameError(
          `frame claims ${length} bytes, over the ${MAX_FRAME_BYTES} limit — ` +
            `the stream is out of step and cannot be resynchronised`,
        );
      }
      if (this.buffer.length < 4 + length) break;

      const body = this.buffer.subarray(4, 4 + length);
      // COPIED rather than kept as a view, and the reason is RETENTION, not
      // correctness — `JSON.parse` below has already made its own strings, so
      // the parsed values are safe either way. `subarray` returns a window onto
      // the parent allocation, so a three-byte remainder left as a view would
      // hold a 900 KB chunk alive until the next message happened to complete.
      // Copying three bytes is cheaper than that, every time.
      this.buffer = Buffer.from(this.buffer.subarray(4 + length));

      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch (err) {
        throw new FrameError(
          `frame of ${length} bytes is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  /** Bytes held back waiting for the rest of a frame. Tests assert on this. */
  get pending(): number {
    return this.buffer.length;
  }
}
