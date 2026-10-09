/**
 * `atlarix acp`: stdout carries the editor's JSON-RPC and nothing else.
 *
 * Imported FIRST by entry.mts. One stray line on stdout (a module's
 * console.log, a library banner) is a parse error in the editor and kills
 * the connection. So, in ACP mode only:
 * - the real stdout writer is kept here, for the ACP stream alone;
 * - `process.stdout.write` and `console.log/info/debug` go to stderr, which the
 *   editor shows as the agent's log.
 *
 * It has to run before anything else loads: electron-log, for one, keeps
 * whatever `console` functions existed when it was imported.
 */
type Write = (chunk: Uint8Array | string, cb?: (err?: Error | null) => void) => boolean;

let acpWrite: Write | null = null;

if (process.argv.slice(2)[0] === "acp") {
  const real = process.stdout.write.bind(process.stdout) as Write;
  acpWrite = real;
  const toStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((...args: Parameters<typeof process.stderr.write>) =>
    toStderr(...args)) as typeof process.stdout.write;
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
}

/** The real stdout, for the ACP stream only. Null outside `atlarix acp`. */
export function acpStdout(): Write | null {
  return acpWrite;
}
