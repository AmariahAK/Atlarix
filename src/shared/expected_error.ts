/**
 * A condition the user caused and can put right (a Recent folder they moved or
 * deleted), not a bug. IPC handlers log it and never send it to Sentry
 * (ATLARIX-45: every "Source folder does not exist" was reported), and the
 * renderer shows its message as it is.
 *
 * Electron passes only an Error's message across IPC, so the kind travels in
 * the message as a marker that `expectedErrorOf` reads back.
 */
export type ExpectedErrorKind = "folder-missing";

export class ExpectedUserError extends Error {
  constructor(
    message: string,
    readonly kind: ExpectedErrorKind,
  ) {
    super(message);
    this.name = "ExpectedUserError";
  }
}

const MARKER = /\[expected:([a-z-]+)\] ([\s\S]*)$/;

/** The message an IPC handler rethrows, carrying the kind. */
export function expectedErrorMessage(e: ExpectedUserError): string {
  return `[expected:${e.kind}] ${e.message}`;
}

/** The kind and plain message of an expected error that crossed IPC, else null. */
export function expectedErrorOf(
  e: unknown,
): { kind: ExpectedErrorKind; message: string } | null {
  if (e instanceof ExpectedUserError) return { kind: e.kind, message: e.message };
  const m = MARKER.exec(e instanceof Error ? e.message : String(e ?? ""));
  return m ? { kind: m[1] as ExpectedErrorKind, message: m[2] } : null;
}
