import { describe, expect, it } from "vitest";
import { stableStringify } from "@/lib/automations/pollers/mcp";

/**
 * The `pollGithub` suite that used to sit above this was deleted with the GitHub
 * poller itself: polling one vendor's API is a hardcoded instance of a generic
 * capability, and it could never serve GitLab or Bitbucket. MCP triggers are the
 * host-agnostic replacement, which is what `stableStringify` below serves — it
 * is how an MCP poll decides whether a result actually changed.
 */

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(
      stableStringify({ a: [{ x: 1, y: 2 }], b: 1 }),
    );
  });
});
