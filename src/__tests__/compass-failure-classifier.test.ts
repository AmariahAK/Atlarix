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
    expect(message).toMatch(/credit is used up/i);
    expect(message).not.toContain("support@atlarix.dev");
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
    expect(message).toMatch(/trouble reaching Atlarix Core/i);
    expect(isCompassInfraError).toBe(true);
  });
});
