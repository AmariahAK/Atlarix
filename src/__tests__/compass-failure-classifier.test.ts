/**
 * Which message a Core failure produces — and specifically, in what ORDER the
 * cases are tried.
 *
 * The ordering is not cosmetic. A ban arrives from the proxy as **403**, and the
 * pre-existing 401/403 branch maps that to "your session expired, sign in again".
 * A banned user following that instruction signs in successfully and is no better
 * off, having been told the wrong thing by the app. So the ban case is matched on
 * the BODY and matched first. That is exactly the class of bug these assertions
 * exist to prevent, and it had no coverage at all before.
 */
import { describe, it, expect } from "vitest";
import { classifyCompassFailure } from "@/lib/chat/compass-failure-classifier";
import { CORE_EXHAUSTED_MARKER, CORE_REACHABILITY_MARKER } from "@/shared/billing_copy";

describe("classifyCompassFailure", () => {
  it("a 403 account_banned is a BAN, not an expired session", () => {
    const { message, isCompassInfraError } = classifyCompassFailure(
      403,
      '{"error":"account_banned"}',
    );
    expect(message).toContain("support@atlarix.dev");
    expect(message).not.toMatch(/sign in again|session expired/i);
    // Not our outage — do not report it as infrastructure.
    expect(isCompassInfraError).toBe(false);
  });

  it("a 403 WITHOUT that body is still an expired session", () => {
    const { message } = classifyCompassFailure(403, '{"error":"unauthorized"}');
    expect(message).not.toContain("support@atlarix.dev");
  });

  it("402 insufficient_credit says top up, not banned", () => {
    const { message } = classifyCompassFailure(402, '{"error":"insufficient_credit"}');
    // Asserted through the MARKER the error box matches on, not a hand-typed
    // phrase: this test previously pinned a substring of copy that lives in
    // another module, so rewording that copy failed here for a reason the
    // failure message could not explain.
    expect(message).toContain(CORE_EXHAUSTED_MARKER);
    expect(message).not.toContain("support@atlarix.dev");
  });

  /**
   * The proxy has always sent `required_cents` on its 402; the app used to discard it,
   * so a refusal could only say "you have run out". These pin that it now reaches the
   * user, and — more importantly — that FAILING to parse it still produces the plain
   * refusal. This code runs inside an error handler, so a body it cannot read must
   * degrade, never throw.
   */
  it("402 quotes the amount the proxy said it needs", () => {
    const { message } = classifyCompassFailure(
      402,
      '{"error":"insufficient_credit","required_cents":924}',
    );
    expect(message).toContain(CORE_EXHAUSTED_MARKER);
    expect(message).toContain("$9.24");
    // "at least", never "costs": the figure is a worst-case reserve, and a real turn
    // usually settles well under it.
    expect(message).toMatch(/at least/i);
    expect(message).not.toMatch(/costs/i);
  });

  it("402 embedded in a wrapper message still yields the amount", () => {
    // The body does not always arrive as a bare JSON document — the SDK wraps it.
    const { message } = classifyCompassFailure(
      402,
      'Provider error: {"error":"insufficient_credit","required_cents":10} (status 402)',
    );
    expect(message).toContain("$0.10");
  });

  it.each([
    ['{"error":"insufficient_credit"}', "field absent"],
    ["not json at all", "unparseable"],
    ['{"error":"insufficient_credit","required_cents":0}', "zero"],
    ['{"error":"insufficient_credit","required_cents":"abc"}', "non-numeric"],
    ['{"error":"insufficient_credit","required_cents":null}', "null"],
  ])("402 with an unusable amount (%s) still refuses cleanly", (body) => {
    const { message } = classifyCompassFailure(402, body);
    expect(message).toContain(CORE_EXHAUSTED_MARKER);
    expect(message).not.toMatch(/\$/);
  });

  it("a ban never reads as insufficient credit, even at 402", () => {
    // Defence in depth: if a ban ever surfaced with a 402 status, the body still wins.
    const { message } = classifyCompassFailure(402, '{"error":"account_banned"}');
    expect(message).toContain("support@atlarix.dev");
  });

  it("503 core_unavailable is OUR problem", () => {
    const { isCompassInfraError } = classifyCompassFailure(503, "core_unavailable");
    expect(isCompassInfraError).toBe(true);
  });

  it("400/422 surfaces what the provider actually said", () => {
    const { message, isCompassInfraError } = classifyCompassFailure(
      400,
      "context_length_exceeded",
    );
    expect(message).toContain("context_length_exceeded");
    expect(isCompassInfraError).toBe(true);
  });

  it("anything unrecognised degrades to reachability, flagged as ours", () => {
    const { message, isCompassInfraError } = classifyCompassFailure(undefined, "");
    expect(message).toContain(CORE_REACHABILITY_MARKER);
    expect(isCompassInfraError).toBe(true);
  });
});
