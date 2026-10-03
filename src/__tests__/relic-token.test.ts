/**
 * The relic view token (supabase/functions/_shared/relic-token.ts): minted by
 * the edge function, checked by the relics.atlarix.dev Worker. The vector pins
 * the format the Worker's copy (workers/relics/token.js) is tested against.
 */
import { describe, expect, it } from "vitest";
import { signRelicToken, verifyRelicToken } from "../../supabase/functions/_shared/relic-token";

const SECRET = "test-secret-please-ignore";

describe("relic view tokens", () => {
  it("round-trips a relic id until it expires", async () => {
    const t = await signRelicToken(SECRET, "rl_abc", 60, 1_000);
    expect(await verifyRelicToken(SECRET, t, 1_030)).toBe("rl_abc");
    expect(await verifyRelicToken(SECRET, t, 1_061)).toBeNull();
  });

  it("refuses another secret, a changed payload, and garbage", async () => {
    const t = await signRelicToken(SECRET, "rl_abc", 60, 1_000);
    expect(await verifyRelicToken("other", t, 1_010)).toBeNull();
    const [, sig] = t.split(".");
    const forged = `${btoa(JSON.stringify({ r: "rl_someone_else", e: 9_999 })).replace(/=+$/, "")}.${sig}`;
    expect(await verifyRelicToken(SECRET, forged, 1_010)).toBeNull();
    expect(await verifyRelicToken(SECRET, "nope", 1_010)).toBeNull();
    expect(await verifyRelicToken(SECRET, "a.b.c", 1_010)).toBeNull();
  });

  it("matches the shared vector", async () => {
    expect(await signRelicToken(SECRET, "rl_vector", 900, 1_800_000_000)).toBe(VECTOR);
  });
});

/** Also in atlarix-launchpad/workers/relics/token.test.js. */
const VECTOR = "eyJyIjoicmxfdmVjdG9yIiwiZSI6MTgwMDAwMDkwMH0.XabcF2uw57mSfdt4x6tpozNRWhYtfHlxnN3kQ7Nfu-c";
