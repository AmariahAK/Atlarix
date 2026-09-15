/**
 * The only place model-authored code ever runs — and it runs in a WORKER.
 *
 * ══ WHY A WORKER AND NOT THE SANDBOXED FRAME ITSELF ══
 *
 * The relic sandbox executes the model's HTML on the frame's own main thread,
 * which is fine for a document: it draws and stops. Code that BUILDS something
 * can loop forever, and the question that decides this design is not who gets
 * starved by that loop — it is WHO CAN STOP IT.
 *
 * A frame cannot time out its own synchronous code. The timer that would fire
 * is a task on the very thread the loop is occupying, so a runaway run inside
 * the frame could only be ended from outside it, by destroying the frame — and
 * that destroys the protocol state and the only thing listening for the next
 * request along with it. A worker is ended by `terminate()`, from the frame,
 * immediately, and the frame is still there afterwards to report the timeout
 * and take the next run. Verified against the built extension: the runner
 * serves a fresh run correctly straight after terminating a `for(;;)`.
 *
 * WHAT IS NOT THE REASON, recorded because an earlier version of this comment
 * claimed it and was wrong: a spinning sandboxed frame does NOT starve its
 * host. Chrome gives the opaque-origin frame its own process, and the host kept
 * 98% of its message throughput while a frame span for three seconds. The
 * figures that said otherwise came from a broken harness that was really
 * measuring Chrome's background-tab timer clamp — which looks exactly like
 * starvation and is not. Measure with a MessageChannel, never with setInterval,
 * and always against a baseline in the same tab.
 *
 * ══ WHAT THE WORKER CAN REACH, MEASURED RATHER THAN ASSUMED ══
 *
 * It is a blob worker created INSIDE the sandboxed page, so it inherits that
 * page's opaque origin and its CSP. Verified in Chrome against the shipped
 * policy string:
 *
 *   - `fetch` REJECTS — `connect-src 'none'` is inherited by the worker. Model
 *     code cannot send a byte anywhere. This is the property that makes it safe
 *     to feed it the user's own files.
 *   - `new Function` works — `'unsafe-eval'` is inherited too, which is what
 *     lets the code be a string at all.
 *   - `CompressionStream("deflate-raw")` works, which is what makes `zip()`
 *     below a real ZIP rather than a stored-only approximation.
 *   - `worker-src blob:` had to be ADDED to the manifest's sandbox CSP. Without
 *     it the `child-src 'none'` already there blocks the worker outright, and
 *     the only symptom is a bare `error` event with no message.
 *
 * ══ WHY THERE IS A `zip` HELPER AND NOTHING ELSE LIKE IT ══
 *
 * The instruction this feature exists to satisfy is "do not try to keep up with
 * formats" — so there is no xlsx writer, no docx writer, no pdf writer. The
 * model writes whatever the format needs.
 *
 * `zip` is the one exception and it is not a format writer: .xlsx, .docx,
 * .pptx, .odt, .epub and .zip are all the SAME container, and the parts of it
 * that are easy to get wrong (the CRC-32, the two copies of every header, the
 * central directory offsets) are wrong in ways that produce a file which opens
 * nowhere and explains nothing. `panel/ooxml.ts` already READS this container
 * with the browser's inflater; this is the inverse of the same argument.
 */

/** A file the model's code handed back. */
export interface SandboxFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** A file the model asked to be given — an attachment, or something it made. */
export interface SandboxInput {
  name: string;
  type: string;
  bytes: Uint8Array;
  /** Present only when the bytes are known to be text. Never guessed. */
  text: string | null;
}

/**
 * Bounds, passed in rather than hard-coded here.
 *
 * The caller owns them because the caller owns the consequences: `stdoutChars`
 * is spent in the MODEL'S CONTEXT on every later turn, and the byte caps are
 * spent in the panel's memory. A worker cannot see either cost.
 */
export interface SandboxLimits {
  stdoutChars: number;
  fileBytes: number;
  totalBytes: number;
  maxFiles: number;
}

export interface WorkerRequest {
  kind: "atlarix:worker-run";
  code: string;
  inputs: SandboxInput[];
  limits: SandboxLimits;
}

export interface WorkerResult {
  kind: "atlarix:worker-done";
  ok: boolean;
  stdout: string;
  /** Set when `stdout` hit `limits.stdoutChars` and lost its tail. */
  truncated: boolean;
  error: string | null;
  /** Whatever the code `return`ed, formatted. Null when it returned nothing. */
  value: string | null;
  files: SandboxFile[];
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry carries twice. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc =
      ((CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^
        (crc >>> 8)) >>>
      0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: unknown;
}

/** MS-DOS packed date and time, which is what a ZIP header carries. */
function dosStamp(at: Date): { time: number; date: number } {
  return {
    time:
      (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    // Years since 1980, and ZIP cannot represent anything earlier.
    date:
      ((Math.max(1980, at.getFullYear()) - 1980) << 9) |
      ((at.getMonth() + 1) << 5) |
      at.getDate(),
  };
}

/**
 * Assemble a ZIP archive.
 *
 * `deflate` is a PARAMETER rather than a direct `CompressionStream` call so the
 * container layout can be tested without one — jsdom has no compression streams
 * at all, and the bytes that matter here are the headers, not the payload.
 *
 * An entry whose compressed form is no smaller is STORED instead. That is not
 * an optimisation; deflating an already-compressed part (a PNG inside an
 * .xlsx) reliably grows it, and a container that is bigger for having been
 * compressed is a bug a user would have to measure to notice.
 */
export async function buildZip(
  entries: ZipEntry[],
  deflate: (bytes: Uint8Array) => Promise<Uint8Array>,
  now: Date = new Date(),
): Promise<Uint8Array> {
  const stamp = dosStamp(now);
  const encoder = new TextEncoder();

  const prepared: Array<{
    name: Uint8Array;
    data: Uint8Array;
    payload: Uint8Array;
    method: number;
    crc: number;
  }> = [];

  for (const entry of entries) {
    const data = toBytes(entry.data);
    // Backslashes are not a path separator in ZIP, and a name carrying one
    // unpacks as a single oddly-named file everywhere but Windows.
    const name = encoder.encode(String(entry.name).replace(/\\/g, "/"));
    let payload = data;
    let method = 0;
    if (data.length > 0) {
      const squeezed = await deflate(data);
      if (squeezed.length < data.length) {
        payload = squeezed;
        method = 8;
      }
    }
    prepared.push({ name, data, payload, method, crc: crc32(data) });
  }

  const localSize = prepared.reduce(
    (n, e) => n + 30 + e.name.length + e.payload.length,
    0,
  );
  const centralSize = prepared.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);

  let at = 0;
  const offsets: number[] = [];
  for (const e of prepared) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true); // local file header
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, 0x0800, true); // names are UTF-8
    view.setUint16(at + 8, e.method, true);
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, e.crc, true);
    view.setUint32(at + 18, e.payload.length, true);
    view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, e.name.length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    out.set(e.name, at + 30);
    out.set(e.payload, at + 30 + e.name.length);
    at += 30 + e.name.length + e.payload.length;
  }

  const centralAt = at;
  for (let i = 0; i < prepared.length; i += 1) {
    const e = prepared[i] as (typeof prepared)[number];
    view.setUint32(at, 0x02014b50, true); // central directory header
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, e.method, true);
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, e.crc, true);
    view.setUint32(at + 20, e.payload.length, true);
    view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, e.name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk number
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[i] as number, true);
    out.set(e.name, at + 46);
    at += 46 + e.name.length;
  }

  view.setUint32(at, 0x06054b50, true); // end of central directory
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralAt, true);
  view.setUint16(at + 20, 0, true); // no archive comment

  return out;
}

// ---------------------------------------------------------------------------
// Coercion and labelling
// ---------------------------------------------------------------------------

/**
 * Anything byte-shaped, as bytes.
 *
 * A plain number array is accepted because a model writing a PDF header by hand
 * reaches for one, and refusing it would cost a round trip over a technicality.
 */
export function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  throw new TypeError(
    "expected a string, a Uint8Array, an ArrayBuffer or an array of byte " +
      `values — got ${data === null ? "null" : typeof data}`,
  );
}

/**
 * A MIME type from the extension, so the download lands in the right app.
 *
 * NOT a format registry and must not grow into one — nothing here can write any
 * of these, and an unknown extension is answered rather than refused. It exists
 * because `application/octet-stream` makes macOS hand a .docx to TextEdit.
 */
const MIME: Record<string, string> = {
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
  ics: "text/calendar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  epub: "application/epub+zip",
};

export function guessMime(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * A file name that cannot be a path.
 *
 * These names reach `<a download>`, which Chrome sanitises on its own — but the
 * name is also shown in the panel and used to find the file again on a later
 * call, so it is normalised HERE, once, rather than differently in three places.
 */
export function safeName(raw: unknown): string {
  const name = String(raw ?? "")
    // eslint-disable-next-line no-control-regex -- stripping controls is the point
    .replace(/[ -]/g, "")
    .replace(/[\\/]+/g, "_")
    // The leading run goes AFTER the separators collapse, not before: without
    // that ordering "../../etc/passwd" normalises to "_.._etc_passwd" — safe,
    // since nothing that could be a separator survives, but a bizarre name to
    // hand a user. Underscores are included because they are what a stripped
    // separator left behind.
    .replace(/^[._\s]+/, "")
    .replace(/_{2,}/g, "_")
    .trim()
    .slice(0, 120);
  return name || "untitled";
}

/** `console.log`'s arguments as one line, without throwing on a cycle. */
export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (value === undefined) return "undefined";
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_key, v: unknown) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]";
          seen.add(v);
        }
        if (typeof v === "bigint") return `${v}n`;
        if (typeof v === "function") return "[function]";
        return v;
      },
      2,
    );
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Host {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", fn: (e: MessageEvent) => void) => void;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  stdoutChars: 8_000,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  maxFiles: 12,
};

/**
 * Install the API the model's code sees, and wait for a run request.
 *
 * Exported and called at the bottom rather than run on import, so the pure
 * helpers above can be tested in an environment that has no worker at all.
 */
export function install(host: Host): void {
  const stdout: string[] = [];
  let stdoutChars = 0;
  let truncated = false;
  let answered = false;
  let limits: SandboxLimits = DEFAULT_LIMITS;

  const files: SandboxFile[] = [];
  let totalBytes = 0;

  const write = (parts: unknown[]): void => {
    if (truncated) return;
    const line = parts.map(formatValue).join(" ");
    if (stdoutChars + line.length > limits.stdoutChars) {
      stdout.push(line.slice(0, Math.max(0, limits.stdoutChars - stdoutChars)));
      truncated = true;
      return;
    }
    stdout.push(line);
    stdoutChars += line.length + 1;
  };

  const api = host as unknown as Record<string, unknown>;

  // CAPTURED NOW, NOT READ LATER. The run replaces `postMessage` on this same
  // object so the model's code cannot speak as the worker — and `finish` would
  // otherwise resolve the replacement and post the result into a no-op, leaving
  // every single run to die by timeout instead. Bind before anything shadows it.
  const post = host.postMessage.bind(host);

  api.console = {
    log: (...a: unknown[]) => write(a),
    info: (...a: unknown[]) => write(a),
    warn: (...a: unknown[]) => write(a),
    error: (...a: unknown[]) => write(a),
    debug: (...a: unknown[]) => write(a),
  };

  /**
   * Hand a file back to the user.
   *
   * THROWS rather than returning false on a refusal. A cap that is silently
   * ignored produces a run that reports success and hands over nothing, and the
   * model's next move is to describe a file the user does not have.
   */
  api.emit = (name: unknown, data: unknown, mime?: unknown): string => {
    if (files.length >= limits.maxFiles) {
      throw new Error(
        `emit() refused: this run already produced ${limits.maxFiles} files, ` +
          `which is the limit. Combine them into a zip.`,
      );
    }
    const clean = safeName(name);
    const bytes = toBytes(data);
    if (bytes.length > limits.fileBytes) {
      throw new Error(
        `emit() refused "${clean}": ${Math.round(bytes.length / 1024)} KB is ` +
          `over the ${Math.round(limits.fileBytes / 1024 / 1024)} MB per-file limit.`,
      );
    }
    if (totalBytes + bytes.length > limits.totalBytes) {
      throw new Error(
        `emit() refused "${clean}": this run has already produced ` +
          `${Math.round(totalBytes / 1024)} KB and the total limit is ` +
          `${Math.round(limits.totalBytes / 1024 / 1024)} MB.`,
      );
    }
    totalBytes += bytes.length;
    // COPIED, because the model's code may go on mutating the array it passed —
    // and a file whose bytes change after it was handed over is the kind of
    // defect that only shows up once the file has been saved and opened.
    files.push({
      name: clean,
      mime: String(mime ?? "") || guessMime(clean),
      bytes: bytes.slice(),
    });
    return clean;
  };

  api.zip = (entries: unknown): Promise<Uint8Array> => {
    if (!Array.isArray(entries)) {
      return Promise.reject(
        new TypeError("zip() takes an array of { name, data } entries"),
      );
    }
    return buildZip(entries as ZipEntry[], async (bytes) => {
      const stream = new CompressionStream("deflate-raw");
      const writer = stream.writable.getWriter();
      // The cast covers `Uint8Array<ArrayBufferLike>` vs `BufferSource`, which
      // differ only over SharedArrayBuffer — and nothing here can produce one:
      // `toBytes` is the single constructor and a worker has no shared memory.
      void writer.write(bytes as unknown as BufferSource);
      void writer.close();
      return new Uint8Array(await new Response(stream.readable).arrayBuffer());
    });
  };

  const finish = (result: Omit<WorkerResult, "kind">): void => {
    if (answered) return;
    answered = true;
    post({ kind: "atlarix:worker-done", ...result });
  };

  host.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as WorkerRequest | null;
    if (!message || message.kind !== "atlarix:worker-run") return;
    if (message.limits) limits = message.limits;
    api.inputs = message.inputs ?? [];

    // THE MODEL'S CODE MUST NOT BE ABLE TO SPEAK AS THE WORKER. `finish` holds
    // the real `postMessage`; this replaces the global one, so a `postMessage`
    // inside the run cannot pre-empt the result the runner is waiting for.
    api.postMessage = () => {};

    let run: () => Promise<unknown>;
    try {
      // Wrapped in an async IIFE so the code may `await` at its top level and
      // `return` a value — both of which a model writes without being asked to.
      run = new Function(
        `return (async () => {\n${String(message.code ?? "")}\n})();`,
      ) as () => Promise<unknown>;
    } catch (err) {
      finish({
        ok: false,
        stdout: stdout.join("\n"),
        truncated,
        error: `Your code did not parse — ${err instanceof Error ? err.message : String(err)}`,
        value: null,
        files: [],
      });
      return;
    }

    void Promise.resolve()
      .then(run)
      .then(
        (value) => {
          finish({
            ok: true,
            stdout: stdout.join("\n"),
            truncated,
            error: null,
            value: value === undefined ? null : formatValue(value),
            files,
          });
        },
        (err: unknown) => {
          const stack =
            err instanceof Error && err.stack
              ? `\n${err.stack.split("\n").slice(1, 4).join("\n")}`
              : "";
          // FILES ARE STILL HANDED OVER after a throw. Code that wrote three
          // sheets and then divided by zero produced three real files, and
          // discarding them would make the user re-run the whole thing.
          finish({
            ok: false,
            stdout: stdout.join("\n"),
            truncated,
            error:
              err instanceof Error
                ? `${err.name}: ${err.message}${stack}`
                : String(err),
            value: null,
            files,
          });
        },
      );
  });
}

// Only inside a real worker. In a test `self` is jsdom's window, which has no
// `WorkerGlobalScope` — so importing this module for its helpers installs
// nothing and overrides no console.
declare const WorkerGlobalScope: (new () => object) | undefined;
if (
  typeof WorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  install(self as unknown as Host);
}
