import { describe, it, expect } from "vitest";
import { isNetworkStreamError } from "@/ipc/handlers/chat_stream/network-retry";

/**
 * A provider disconnect must be recognised as retryable, however undici dresses it.
 *
 * Observed on a real Terminal-Bench 4.0 trial: the run died with
 * `UND_ERR_SOCKET` / "other side closed" and the log contained neither a retry
 * line nor a fatal line, because the rejection escaped every handler. The
 * classifier only inspected the top-level message, so a wrapper carrying the
 * socket fault in `cause` read as a programming bug and the trial scored 0 with
 * the work half done.
 */

const socketFault = () => {
  const e = new Error("other side closed") as Error & { name: string; code: string };
  e.name = "SocketError";
  e.code = "UND_ERR_SOCKET";
  return e;
};

describe("isNetworkStreamError: undici socket faults", () => {
  it("recognises the wrapper undici actually throws", () => {
    const outer = new TypeError("terminated") as TypeError & { cause: unknown };
    outer.cause = socketFault();
    expect(isNetworkStreamError(outer)).toBe(true);
  });

  it("recognises the bare socket error by code", () => {
    // "other side closed" matched none of the original patterns, and the code was
    // never consulted, so this classified as a bug.
    expect(isNetworkStreamError(socketFault())).toBe(true);
  });

  it("follows `cause` when the outer message says nothing useful", () => {
    const opaque = new Error("request failed") as Error & { cause: unknown };
    opaque.cause = socketFault();
    expect(isNetworkStreamError(opaque)).toBe(true);
  });

  it("still fails fast on a genuine bug", () => {
    // The point of absorbing network faults is that they are transient. A
    // programming error is not, and must keep ending the run.
    expect(isNetworkStreamError(new TypeError("x is not a function"))).toBe(false);
    expect(isNetworkStreamError(new Error("no such file or directory"))).toBe(false);
  });

  it("never treats an abort as a fault", () => {
    // An abort is a decision, not a failure; retrying it fights the caller.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isNetworkStreamError(abort)).toBe(false);
    const wrapped = new Error("terminated") as Error & { name: string };
    wrapped.name = "AbortError";
    expect(isNetworkStreamError(wrapped)).toBe(false);
  });

  it("terminates on a cyclic cause chain instead of hanging", () => {
    const cyc = new Error("opaque") as Error & { cause?: unknown };
    cyc.cause = cyc;
    expect(isNetworkStreamError(cyc)).toBe(false);
  });
});
