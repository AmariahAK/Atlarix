import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/core";
import { sentryBeforeSendDropExpected } from "@/lib/sentry-before-send";
import { workspaceCapRefusal } from "@/lib/workspace-caps";
import {
  TEARDOWN_STREAM_STOP,
  USER_CANCEL_STREAM_STOP,
  streamStopAbortReason,
} from "@/lib/stream/stream-stop-sentinels";

describe("sentryBeforeSendDropExpected", () => {
  /**
   * Replaces two tests that asserted the drop for `PlanLimitError` and for
   * "Free plan allows 1 workspace…". Both described errors the app can no longer
   * produce — it went free on 2026-09-08 and there is no workspace cap — and by
   * constructing the error by hand they kept a dead class and four dead patterns
   * alive. A fixture is not evidence that a code path exists.
   *
   * The message comes from `workspaceCapRefusal` rather than a literal, so rewording
   * the refusal without updating the matcher fails here instead of silently
   * un-dropping the noise.
   *
   * `"skills"` was dropped from this list in v14.45 for the same reason the patterns
   * above were: the skills cap retired with the marketplace, its only enforcement site,
   * so a refusal for it is now another error the app cannot produce. The type is what
   * caught it — `WorkspaceCapKind` no longer has the member, so this fails to compile
   * rather than passing forever against a fixture.
   */
  it.each(["mcp", "automations"] as const)(
    "drops the %s workspace-cap refusal",
    (kind) => {
      const event = {
        exception: {
          values: [{ type: "Error", value: workspaceCapRefusal(kind) }],
        },
      };
      expect(
        sentryBeforeSendDropExpected(event as ErrorEvent, undefined),
      ).toBeNull();
    },
  );

  /**
   * A USER PRESSING STOP MUST NOT FILE A BUG REPORT.
   *
   * Observed 2026-09-09 in the packaged build: one Stop press produced two Sentry
   * events (`AbortError: This operation was aborted`, `mechanism:
   * onunhandledrejection`). Both cancel handlers aborted with NO reason, so the
   * detached SDK promises rejected as a bare AbortError that matched none of the
   * intentional-stop sentinels — and the process-level net cannot tell a deliberate
   * stop from a real fault without one. Every stop we perform ourselves now carries a
   * reason.
   *
   * Both directions are asserted: the two forms Sentry actually delivers (a structured
   * `originalException`, and text-only when the DOMException is not attached), and that
   * a genuine abort with no sentinel is still REPORTED — a filter that drops every
   * AbortError would hide real cancellations mid-request.
   */
  describe("intentional stream stops are not defects", () => {
    const abortEvent = (value: string) =>
      ({
        exception: { values: [{ type: "AbortError", value }] },
      }) as ErrorEvent;

    it.each([USER_CANCEL_STREAM_STOP, TEARDOWN_STREAM_STOP])(
      "drops a stop carrying the %s sentinel, via originalException",
      (sentinel) => {
        const original = streamStopAbortReason(sentinel);
        expect(
          sentryBeforeSendDropExpected(
            abortEvent("This operation was aborted"),
            {
              originalException: original,
            },
          ),
        ).toBeNull();
      },
    );

    it.each([USER_CANCEL_STREAM_STOP, TEARDOWN_STREAM_STOP])(
      "drops a stop carrying the %s sentinel from TEXT alone",
      (sentinel) => {
        // Sentry's own onunhandledrejection integration does not always attach the
        // DOMException, which is the gap `textHasStreamStopSentinel` exists to close.
        expect(
          sentryBeforeSendDropExpected(
            abortEvent(`AbortError: ${sentinel}`),
            undefined,
          ),
        ).toBeNull();
      },
    );

    it("still REPORTS an abort that carries no sentinel", () => {
      // The whole point of naming the reasons rather than dropping the error class:
      // an abort we did not cause is still a signal worth seeing.
      expect(
        sentryBeforeSendDropExpected(
          abortEvent("This operation was aborted"),
          undefined,
        ),
      ).not.toBeNull();
    });
  });

  it("redacts secrets from message, exception value, request URL, and breadcrumbs (A15)", () => {
    const event = {
      message: "auth failed with sk-ant-abcdefghijklmnopqrstuvwxyz0123",
      exception: {
        values: [
          { type: "Error", value: "token ghp_" + "a".repeat(40) + " rejected" },
        ],
      },
      request: { url: "https://api.example.com/x?key=AKIAABCDEFGHIJKLMNOP" },
      breadcrumbs: [{ message: "GET https://x/?t=AKIAABCDEFGHIJKLMNOP" }],
    };
    const out = sentryBeforeSendDropExpected(event as ErrorEvent, undefined);
    expect(out).not.toBeNull();
    expect(out!.message).not.toMatch(/sk-ant-/);
    expect(out!.exception!.values![0]!.value).not.toMatch(/ghp_/);
    expect(out!.request!.url).not.toMatch(/AKIA/);
    expect(out!.breadcrumbs![0]!.message).not.toMatch(/AKIA/);
    expect(out!.message).toMatch(/redacted secret/);
  });

  it("drops missing TextMate grammar scopes", () => {
    const event = {
      exception: {
        values: [
          { type: "Error", value: "Missing grammar for scope: source.lua" },
        ],
      },
    };
    expect(
      sentryBeforeSendDropExpected(event as ErrorEvent, undefined),
    ).toBeNull();
  });

  it("drops benign Electron teardown races (Object has been destroyed)", () => {
    for (const value of [
      "Object has been destroyed",
      "Render frame was disposed before WebFrameMain could be accessed",
    ]) {
      const event = { exception: { values: [{ type: "Error", value }] } };
      expect(
        sentryBeforeSendDropExpected(event as ErrorEvent, undefined),
      ).toBeNull();
    }
  });

  it("drops intentional stream-stop aborts (ask_user_pending)", () => {
    const event = {
      exception: {
        values: [{ type: "AbortError", value: "ask_user_pending" }],
      },
    };
    const abort = new DOMException("ask_user_pending", "AbortError");
    expect(
      sentryBeforeSendDropExpected(event as ErrorEvent, {
        originalException: abort,
      }),
    ).toBeNull();
  });

  it("drops superseded_stream aborts even when originalException is not attached", () => {
    // Real-world leak: Sentry's onunhandledrejection integration reported the
    // benign single-flight abort WITHOUT the DOMException as originalException,
    // so only the serialized "AbortError: superseded_stream" text survives.
    const event = {
      exception: {
        values: [{ type: "AbortError", value: "superseded_stream" }],
      },
    };
    expect(
      sentryBeforeSendDropExpected(event as ErrorEvent, undefined),
    ).toBeNull();
  });

  it("passes through unexpected errors", () => {
    const event = {
      exception: {
        values: [{ type: "Error", value: "Database connection lost" }],
      },
    };
    expect(sentryBeforeSendDropExpected(event as ErrorEvent, undefined)).toBe(
      event,
    );
  });
});
