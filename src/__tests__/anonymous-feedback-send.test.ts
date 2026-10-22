/**
 * A signed-out rating or /feedback is one PostHog event that names nobody, and
 * it counts as sent only when PostHog accepted it (QA A16: queued with the
 * batch, it was "sent" with no network, and the user was thanked for nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getVersion: () => "15.10.1", getPath: () => "/tmp", isPackaged: false } }));
vi.mock("posthog-node", () => ({ PostHog: class {} }));

const was = process.env.POSTHOG_API_KEY;
beforeEach(() => {
  process.env.POSTHOG_API_KEY = "phc_test";
});
afterEach(() => {
  if (was === undefined) delete process.env.POSTHOG_API_KEY;
  else process.env.POSTHOG_API_KEY = was;
});

describe("the signed-out feedback event", () => {
  it("one event to the batch endpoint, with no person, no location and no address", async () => {
    const { sendAnonymousFeedback } = await import("@/main/lib/analytics");
    const calls: Array<{ url: string; body: { api_key: string; batch: Array<Record<string, any>> } }> = [];
    const ok = await sendAnonymousFeedback({ kind: "rating", rating: 3 }, (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{"status":1}', { status: 200 });
    }) as never);
    expect(ok).toBe(true);
    expect(calls[0]!.url).toMatch(/\/batch\/$/);
    const e = calls[0]!.body.batch[0]!;
    expect(e.event).toBe("session_feedback");
    expect(e.properties).toMatchObject({ kind: "rating", rating: 3, $process_person_profile: false, $geoip_disable: true, $ip: null });
    expect(e.properties).not.toHaveProperty("user_id");
  });

  it("no answer, or an error answer: not sent", async () => {
    const { sendAnonymousFeedback } = await import("@/main/lib/analytics");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as never;
    expect(await sendAnonymousFeedback({ kind: "text", body: "x" }, down)).toBe(false);
    const refused = (async () => new Response("", { status: 503 })) as never;
    expect(await sendAnonymousFeedback({ kind: "text", body: "x" }, refused)).toBe(false);
  });
});
