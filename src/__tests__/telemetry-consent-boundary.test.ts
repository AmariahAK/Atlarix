import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { extraFilesErrorClass } from "@/lib/toast";

/**
 * Two claims the product makes about telemetry, and the code that has to keep
 * them true.
 *
 * Both of these were BROKEN while a comment two lines away said they were not,
 * which is the reason these are tests and not comments.
 */

describe("extra_files_error carries no path — the comment that did not hold", () => {
  /**
   * `showExtraFilesToast` opens with "NEVER send `files` — these are absolute
   * paths, which leak the project's structure and usually the OS username" and
   * then sent git's raw error string, which quotes the paths it was working on.
   * The rule was stated and broken in the same function.
   *
   * `extraFilesErrorClass` cannot leak by construction: it matches known git
   * failures and returns a CONSTANT, so no part of the input can reach the
   * event. These assert that property directly rather than trusting a scrub.
   */
  const leaky = [
    "fatal: Unable to create '/Users/amariah/Documents/Github/AI/Atlarix/.git/index.lock': File exists.",
    "error: unable to unlink old 'src/secret-project/api.ts': Permission denied",
    "fatal: not a git repository (or any of the parent directories): /Users/amariah/private/thing",
    "error: Your local changes to 'C:\\Users\\amariah\\work\\app.ts' would be overwritten by merge",
  ];

  it("returns a bounded label, never a fragment of the input", () => {
    for (const raw of leaky) {
      const cls = extraFilesErrorClass(raw);
      // The label is short and from the closed vocabulary.
      expect(cls).toMatch(/^[a-z_]+$/);
      expect(cls.length).toBeLessThan(24);
      // And nothing identifying survives into it.
      expect(cls).not.toContain("amariah");
      expect(cls).not.toContain("/");
      expect(cls).not.toContain("\\");
      expect(cls).not.toContain(".ts");
    }
  });

  it("still distinguishes the failures worth telling apart", () => {
    expect(extraFilesErrorClass(leaky[0]!)).toBe("index_locked");
    expect(extraFilesErrorClass(leaky[1]!)).toBe("permission_denied");
    expect(extraFilesErrorClass(leaky[2]!)).toBe("not_a_repo");
    expect(extraFilesErrorClass(leaky[3]!)).toBe("conflict");
    // An unrecognised failure degrades to a constant, not to the raw text.
    expect(extraFilesErrorClass("something nobody has seen before")).toBe(
      "other",
    );
  });

  it("a username in an UNRECOGNISED error still cannot escape", () => {
    // The important half: the fallback must not pass the string through.
    const cls = extraFilesErrorClass("weird failure in /Users/amariah/x.ts");
    expect(cls).toBe("other");
    expect(cls).not.toContain("amariah");
  });
});

describe("the EVENT itself, not just the helper", () => {
  /**
   * The helper being safe proves nothing if the call site stops using it — a
   * mutation swapping `error_class: extraFilesErrorClass(error)` back to
   * `error_class: error` passed every test above. This asserts on the payload
   * PostHog is actually handed, which is the only thing that leaves the machine.
   */
  it("extra_files_error's payload contains no path and no username", async () => {
    vi.resetModules();
    vi.doMock("sonner", () => ({
      toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
        custom: vi.fn(),
        dismiss: vi.fn(),
      }),
    }));
    const { showExtraFilesToast } = await import("@/lib/toast");
    const capture = vi.fn();

    showExtraFilesToast({
      files: ["/Users/amariah/Documents/Github/AI/Atlarix/src/a.ts"],
      error:
        "fatal: Unable to create '/Users/amariah/Documents/Github/AI/Atlarix/.git/index.lock': File exists.",
      posthog: { capture } as never,
    });

    expect(capture).toHaveBeenCalledTimes(1);
    const [name, props] = capture.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(name).toBe("extra_files_error");
    // The count is the point of the event; the paths never were.
    expect(props.file_count).toBe(1);
    expect(props.error_class).toBe("index_locked");
    expect(props.files).toBeUndefined();
    expect(props.error).toBeUndefined();
    // Belt and braces: nothing anywhere in the payload names the user or a path.
    const serialised = JSON.stringify(props);
    expect(serialised).not.toContain("amariah");
    expect(serialised).not.toContain("/Users");
    expect(serialised).not.toContain(".git");
    vi.doUnmock("sonner");
  });
});

describe("PostHog writes nothing to the device before consent", () => {
  /**
   * `before_send` dropped every event without consent, and that was believed to
   * be enough. It was not: `posthog.init` writes a distinct id to localStorage
   * AND a cookie, and `posthog.identify` writes again — on the device of someone
   * who answered "No thanks", and before the first-run modal was even shown.
   *
   * The gate is on INITIALISATION, deliberately not on `persistence`: reverting
   * that to "memory" would re-break `$session_id` continuity across launches,
   * which is the regression the persistence comment exists to record.
   */
  const initSpy = vi.fn(() => ({ __client: true }));
  const identifySpy = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    initSpy.mockClear();
    identifySpy.mockClear();
    vi.doMock("posthog-js", () => ({
      default: {
        init: initSpy,
        identify: identifySpy,
        register: vi.fn(),
        startSessionRecording: vi.fn(),
        stopSessionRecording: vi.fn(),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("posthog-js");
  });

  async function load(optedIn: boolean) {
    vi.doMock("@/hooks/useSettings", () => ({
      isTelemetryOptedIn: () => optedIn,
    }));
    return await import("@/lib/analytics/posthog-client");
  }

  it("does NOT init when consent is absent", async () => {
    const m = await load(false);
    m.setPostHogConfig("phc_key", "anon-1");
    expect(m.ensurePostHogInitialized()).toBeNull();
    // Neither call happens, so neither localStorage nor a cookie is written.
    expect(initSpy).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
    expect(m.getPostHogClient()).toBeNull();
  });

  it("DOES init once consent exists, and keeps persistent storage", async () => {
    const m = await load(true);
    m.setPostHogConfig("phc_key", "anon-1");
    expect(m.ensurePostHogInitialized()).not.toBeNull();
    expect(initSpy).toHaveBeenCalledTimes(1);
    // The session-continuity fix must survive the consent gate.
    const opts = (initSpy.mock.calls[0] as unknown as unknown[])[1];
    expect(opts).toMatchObject({
      persistence: "localStorage+cookie",
      disable_session_recording: true,
      autocapture: false,
    });
    expect(identifySpy).toHaveBeenCalledWith("anon-1");
  });

  it("is idempotent — the opt-in hook can fire on every settings load", async () => {
    const m = await load(true);
    m.setPostHogConfig("phc_key", "anon-1");
    m.ensurePostHogInitialized();
    m.ensurePostHogInitialized();
    m.ensurePostHogInitialized();
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("does nothing without a config, even when opted in", async () => {
    const m = await load(true);
    expect(m.ensurePostHogInitialized()).toBeNull();
    expect(initSpy).not.toHaveBeenCalled();
  });
});

describe("location for opted-in usage data", () => {
  /**
   * posthog-node turns GeoIP OFF by default and the renderer used to blank
   * `$ip`, so no event ever had a country. The consent text now says location
   * is included (and the address isn't kept); these hold the code to it.
   */
  afterEach(() => {
    vi.doUnmock("posthog-node");
    vi.doUnmock("posthog-js");
    vi.doUnmock("@/hooks/useSettings");
  });

  it("the desktop and CLI client asks PostHog for the location", async () => {
    vi.resetModules();
    const ctor = vi.fn();
    vi.doMock("posthog-node", () => ({
      PostHog: class {
        constructor(...a: unknown[]) {
          ctor(...a);
        }
      },
    }));
    const prev = process.env.POSTHOG_API_KEY;
    process.env.POSTHOG_API_KEY = "phc_test";
    try {
      const m = await import("@/main/lib/analytics");
      m.getPostHog();
      expect(ctor).toHaveBeenCalledWith("phc_test", expect.objectContaining({ disableGeoip: false }));
    } finally {
      if (prev === undefined) delete process.env.POSTHOG_API_KEY;
      else process.env.POSTHOG_API_KEY = prev;
    }
  });

  it("the app's client no longer blanks the address PostHog locates from", async () => {
    vi.resetModules();
    const init = vi.fn(() => ({ __client: true }));
    vi.doMock("posthog-js", () => ({
      default: { init, identify: vi.fn(), register: vi.fn(), startSessionRecording: vi.fn(), stopSessionRecording: vi.fn() },
    }));
    vi.doMock("@/hooks/useSettings", () => ({ isTelemetryOptedIn: () => true }));
    const m = await import("@/lib/analytics/posthog-client");
    m.setPostHogConfig("phc_key", "anon-1");
    m.ensurePostHogInitialized();
    const opts = (init.mock.calls[0] as unknown as Array<{ before_send: (e: unknown) => unknown }>)[1];
    const event = { properties: { $ip: "203.0.113.7" } };
    expect(opts.before_send(event)).toMatchObject({ properties: { $ip: "203.0.113.7" } });
  });
});
