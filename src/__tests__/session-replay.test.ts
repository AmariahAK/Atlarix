/**
 * Session replay in the app's window (item 12, owner + ai-45 2026-10-22):
 * only with analytics on, never before consent is known; every word masked;
 * a share of launches, drawn once; a withdrawal stops it at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPLAY_RECORDING_OPTIONS,
  REPLAY_SAMPLE_RATE,
  maskAttribute,
  replaySampleRate,
  setHostedReplaySampleRate,
} from "@/lib/analytics/replay";

const ph = {
  init: vi.fn(() => ({ __client: true })),
  identify: vi.fn(),
  register: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
};
let consent = false;

beforeEach(() => {
  vi.resetModules();
  for (const f of Object.values(ph)) f.mockClear();
  consent = false;
  vi.doMock("posthog-js", () => ({ default: ph }));
  vi.doMock("posthog-js/dist/posthog-recorder", () => ({}));
  vi.doMock("@/hooks/useSettings", () => ({ isTelemetryOptedIn: () => consent }));
});
afterEach(() => {
  vi.doUnmock("posthog-js");
  vi.doUnmock("posthog-js/dist/posthog-recorder");
  vi.doUnmock("@/hooks/useSettings");
});

const load = async (draw: number, rate?: number) => {
  const m = await import("@/lib/analytics/posthog-client");
  m.__resetPostHogClientForTests(() => draw);
  m.setPostHogConfig("phc_key", "anon-1", "15.10.1", rate);
  return m;
};

describe("when it records", () => {
  it("never before consent is known: no client, no recording", async () => {
    const m = await load(0);
    m.ensurePostHogInitialized();
    m.syncPostHogConsent();
    expect(ph.init).not.toHaveBeenCalled();
    expect(ph.startSessionRecording).not.toHaveBeenCalled();
  });

  it("opted in and drawn: recording starts once, by our draw, with every word masked", async () => {
    consent = true;
    const m = await load(REPLAY_SAMPLE_RATE - 0.01);
    m.ensurePostHogInitialized();
    m.syncPostHogConsent();
    m.syncPostHogConsent();
    expect(ph.startSessionRecording).toHaveBeenCalledTimes(1);
    expect(ph.startSessionRecording).toHaveBeenCalledWith({ sampling: true });
    const opts = (ph.init.mock.calls[0] as unknown as unknown[])[1];
    expect(opts).toMatchObject({
      disable_session_recording: true,
      enable_recording_console_log: false,
      capture_performance: false,
      session_recording: { maskAllInputs: true, maskTextSelector: "*", recordHeaders: false, recordBody: false },
    });
    expect((opts as { session_recording: { blockSelector: string } }).session_recording.blockSelector).toContain("canvas");
  });

  it("opted in, not drawn: nothing recorded this launch", async () => {
    consent = true;
    const m = await load(REPLAY_SAMPLE_RATE + 0.01);
    m.ensurePostHogInitialized();
    m.syncPostHogConsent();
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.startSessionRecording).not.toHaveBeenCalled();
  });

  it("the rate main sends wins over the built-in one", async () => {
    consent = true;
    const m = await load(0.5, 0.6);
    m.ensurePostHogInitialized();
    expect(ph.startSessionRecording).toHaveBeenCalledTimes(1);
  });

  it("consent withdrawn while recording: stopped at once", async () => {
    consent = true;
    const m = await load(0);
    m.ensurePostHogInitialized();
    expect(ph.startSessionRecording).toHaveBeenCalledTimes(1);
    consent = false;
    m.syncPostHogConsent();
    expect(ph.stopSessionRecording).toHaveBeenCalledTimes(1);
    // Given again: back on, under the same launch's draw.
    consent = true;
    m.syncPostHogConsent();
    expect(ph.startSessionRecording).toHaveBeenCalledTimes(2);
  });
});

describe("what it keeps", () => {
  it("attributes: layout only; a title, alt, href or label is masked", () => {
    expect(maskAttribute("class", "flex gap-2")).toBe("flex gap-2");
    expect(maskAttribute("title", "/Users/someone/secret/app.ts")).toBe("********");
    expect(maskAttribute("aria-label", "Open login.tsx")).toBe("********");
    expect(maskAttribute("href", "file:///Users/someone")).not.toContain("someone");
    expect(REPLAY_RECORDING_OPTIONS.maskAttributeFn("alt", "screenshot of code")).not.toContain("code");
  });

  it("the hosted rate: 0 to 1 only, anything else leaves the built-in one", () => {
    setHostedReplaySampleRate(0.1);
    expect(replaySampleRate()).toBe(0.1);
    for (const bad of [2, -1, "0.5", null, Number.NaN]) {
      setHostedReplaySampleRate(bad);
      expect(replaySampleRate()).toBe(REPLAY_SAMPLE_RATE);
    }
  });
});
