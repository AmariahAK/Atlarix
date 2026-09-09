/**
 * The one verdict on "is this failure an empty wallet?"
 *
 * WHY THIS DESERVES ITS OWN FILE. Two unrelated call stacks now branch on this
 * predicate — the main turn's error handler and a sub-agent's — and a false negative
 * is the expensive direction: it puts the round back on the path where a 402 read as
 * an ordinary retryable tool failure and the model retried it, each retry another
 * 402-bound call against a wallet that had already said no.
 *
 * Every case below is a shape the code actually meets. The two-level lookup is not
 * defensive padding: the AI SDK surfaces a provider failure as the thrown value in
 * one path and as `{ error }` on a stream error part in another.
 */

import { describe, expect, it } from "vitest";
import {
  extractCoreErrorParts,
  isInsufficientCreditError,
  requiredCentsFromBody,
  requiredCentsFromError,
} from "@/lib/billing/insufficient-credit";

describe("recognising an empty wallet", () => {
  it("matches a bare 402 on the error itself", () => {
    expect(isInsufficientCreditError({ statusCode: 402 })).toBe(true);
  });

  it("matches a 402 one wrapper deep — the stream error-part shape", () => {
    expect(isInsufficientCreditError({ error: { statusCode: 402 } })).toBe(true);
  });

  it("matches the body marker even with no status at all", () => {
    // The floor gate at server.ts:443 sends `insufficient_credit` without the
    // status surviving every wrapper, so the body alone has to be enough.
    expect(
      isInsufficientCreditError({
        responseBody: '{"error":"insufficient_credit"}',
      }),
    ).toBe(true);
  });

  it("does not claim other Core failures", () => {
    // Each of these has its own branch in the classifier and its own instruction
    // to the user; claiming them here would send a banned account to top up.
    expect(isInsufficientCreditError({ statusCode: 503 })).toBe(false);
    expect(isInsufficientCreditError({ statusCode: 403 })).toBe(false);
    expect(
      isInsufficientCreditError({ responseBody: '{"error":"account_banned"}' }),
    ).toBe(false);
  });

  it("never throws on a shape it has not met", () => {
    // It runs INSIDE an error handler. Throwing here would replace a reportable
    // failure with an unreportable one.
    for (const v of [null, undefined, "", 0, "a string", [], new Error("x")]) {
      expect(() => isInsufficientCreditError(v)).not.toThrow();
      expect(isInsufficientCreditError(v)).toBe(false);
    }
  });

  it("survives a body that cannot be stringified", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      extractCoreErrorParts({ statusCode: 402, responseBody: circular }),
    ).not.toThrow();
    expect(isInsufficientCreditError({ statusCode: 402, responseBody: circular })).toBe(
      true,
    );
  });
});

describe("the required amount", () => {
  it("reads a plain JSON body", () => {
    expect(requiredCentsFromBody('{"required_cents":924}')).toBe(924);
  });

  it("reads it as a string, which is how JSON round-trips sometimes leave it", () => {
    expect(requiredCentsFromBody('{"required_cents":"924"}')).toBe(924);
  });

  it("finds it embedded in a wrapper message", () => {
    // The body often arrives already folded into a provider error string rather
    // than as a bare JSON document — the reason the regex fallback exists.
    expect(
      requiredCentsFromBody(
        'Provider returned 402: {"error":"insufficient_credit","required_cents":1050}',
      ),
    ).toBe(1050);
  });

  it("degrades to null rather than throwing", () => {
    for (const body of ["", "not json", "{}", '{"required_cents":null}', "[]"]) {
      expect(requiredCentsFromBody(body)).toBeNull();
    }
  });

  it("rejects a zero or negative figure", () => {
    // "needs at least $0.00" is worse than saying nothing.
    expect(requiredCentsFromBody('{"required_cents":0}')).toBeNull();
    expect(requiredCentsFromBody('{"required_cents":-5}')).toBeNull();
  });

  it("pulls the figure straight off an error, at either wrapper depth", () => {
    expect(
      requiredCentsFromError({ responseBody: '{"required_cents":924}' }),
    ).toBe(924);
    expect(
      requiredCentsFromError({ error: { responseBody: '{"required_cents":31}' } }),
    ).toBe(31);
  });
});
